/**
 * CLI command router using node:util parseArgs.
 * Zero dependencies — uses only Node.js built-ins.
 */
import {parseArgs} from 'node:util';

/** @type {Map<string, { description: string, options?: object, handler: Function, subcommands?: Map<string, object> }>} */
const commands = new Map();

export function register(name, config) {
  commands.set(name, config);
}

function printHelp() {
  console.log('Usage: tv <command> [options]\n');
  console.log('Commands:');
  const maxLen = Math.max(...[...commands.keys()].map(k => k.length));
  for (const [name, cmd] of commands) {
    if (cmd.subcommands) {
      const subs = [...cmd.subcommands.keys()].join(', ');
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}  [${subs}]`);
    } else {
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}`);
    }
  }
  console.log('\nRun "tv <command> --help" for command-specific options.');
  console.log('\nDISCLAIMER');
  console.log('  Not affiliated with TradingView Inc. or Anthropic, PBC.');
  console.log('  Use subject to TradingView\'s Terms of Use: tradingview.com/policies');
}

function printOptions(opts) {
    if (Object.keys(opts).length > 0) {
        console.log('\nOptions:');
        for (const [k, v] of Object.entries(opts)) {
            const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
            const required = v.required ? ' (required)' : '';
            const def = v.default === undefined ? '' : ` [default: ${v.default}]`;
            console.log(`  ${flag.padEnd(20)}${(v.description || '') + required + def}`);
        }
    }
}

function printCommandHelp(name, cmd) {
  if (cmd.subcommands) {
    console.log(`Usage: tv ${name} <subcommand> [options]\n`);
    console.log('Subcommands:');
    for (const [sub, subConf] of cmd.subcommands) {
      console.log(`  ${sub.padEnd(12)}${subConf.description}`);
    }
  } else {
    console.log(`Usage: tv ${name} [options]\n`);
    console.log(cmd.description);
  }
    printOptions(cmd.options || {});
}

export async function run(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const cmdName = args[0];
  const cmd = commands.get(cmdName);

  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    console.error('Run "tv --help" for a list of commands.');
    process.exit(1);
  }

  // Handle subcommands (e.g., tv pine get)
  if (cmd.subcommands) {
      await runSubcommand(cmdName, cmd, args);
  } else {
      await runCommand(cmdName, cmd, args);
  }
}

async function runSubcommand(cmdName, cmd, args) {
    const subName = args[1];
    if (!subName || subName === '--help' || subName === '-h') {
        printCommandHelp(cmdName, cmd);
        process.exit(0);
    }
    const sub = cmd.subcommands.get(subName);
    if (!sub) {
        console.error(`Unknown subcommand: ${cmdName} ${subName}`);
        printCommandHelp(cmdName, cmd);
        process.exit(1);
    }
    const handler = sub.handler;
    const options = sub.options || {};
    // Parse remaining args after command + subcommand
    try {
        const {values, positionals} = parseArgs({
            args: args.slice(2),
            options: {help: {type: 'boolean', short: 'h'}, ...options},
            allowPositionals: true,
            strict: false,
        });
        if (values.help) {
            printSubcommandHelp(cmdName, subName, sub, options);
            process.exit(0);
        }
        validateOptions(values, options, cmdName, subName);
        await execute(handler, values, positionals);
    } catch (err) {
        handleError(err);
    }
}

function printSubcommandHelp(cmdName, subName, sub, options) {
    console.log(`Usage: tv ${cmdName} ${subName} [options]\n`);
    console.log(sub.description);
    printOptions(options);
}

async function runCommand(cmdName, cmd, args) {
    const handler = cmd.handler;
    const options = cmd.options || {};
    try {
        const {values, positionals} = parseArgs({
            args: args.slice(1),
            options: {help: {type: 'boolean', short: 'h'}, ...options},
            allowPositionals: true,
            strict: false,
        });
        if (values.help) {
            printCommandHelp(cmdName, cmd);
            process.exit(0);
        }
        validateOptions(values, options, cmdName);
        await execute(handler, values, positionals);
    } catch (err) {
        handleError(err);
  }
}

function validateOptions(values, options, cmdName, subName) {
  // options: object where keys = option name, value may contain { required: true }
    checkRequiredOptions(values, options, cmdName, subName);
    checkOneOfGroups(values, options, cmdName, subName);
    checkMutuallyExclusiveGroups(values, options, cmdName, subName);
}

function failValidation(message, cmdName, subName) {
    const full = subName ? `${cmdName} ${subName}` : cmdName;
    console.error(`${message} for command: ${full}`);
    printCommandHelp(cmdName, commands.get(cmdName));
    process.exit(1);
}

function hasValue(values, k) {
    return Object.prototype.hasOwnProperty.call(values, k) && values[k] !== undefined;
}

// 1) Simple required flags
function checkRequiredOptions(values, options, cmdName, subName) {
    for (const [k, v] of Object.entries(options || {})) {
        if (v.required && !hasValue(values, k)) {
            failValidation(`Missing required option --${k}`, cmdName, subName);
        }
    }
}

function collectGroups(options, groupKey) {
  const groups = {};
  for (const [k, v] of Object.entries(options || {})) {
      if (v[groupKey]) {
          groups[v[groupKey]] = groups[v[groupKey]] || [];
          groups[v[groupKey]].push(k);
    }
  }
    return groups;
}

// 2) oneOfGroup: ensure at least one option from each group is present
function checkOneOfGroups(values, options, cmdName, subName) {
    const groups = collectGroups(options, 'oneOfGroup');
  for (const [, keys] of Object.entries(groups)) {
      const anyPresent = keys.some((k) => hasValue(values, k));
    if (!anyPresent) {
        failValidation(`Missing one of the options [${keys.join(', ')}]`, cmdName, subName);
    }
  }
}

// 3) mutuallyExclusiveGroup: ensure at most one option from each group is present
function checkMutuallyExclusiveGroups(values, options, cmdName, subName) {
    const groups = collectGroups(options, 'mutuallyExclusiveGroup');
    for (const [, keys] of Object.entries(groups)) {
        const present = keys.filter((k) => hasValue(values, k));
    if (present.length > 1) {
        failValidation(`Options ${present.join(', ')} are mutually exclusive`, cmdName, subName);
    }
  }
}

async function execute(handler, values, positionals) {
  try {
    const result = await handler(values, positionals);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}

function handleError(err) {
  const message = err.message || String(err);
  // Connection failures get exit code 2
  if (/CDP|connection|ECONNREFUSED|not running/i.test(message)) {
    console.error(JSON.stringify({ success: false, error: message }, null, 2));
    process.exit(2);
  }
  console.error(JSON.stringify({ success: false, error: message }, null, 2));
  process.exit(1);
}
