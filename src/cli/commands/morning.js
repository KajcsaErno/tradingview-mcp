import { register } from '../router.js';
import * as core from '../../core/morning.js';

register('brief', {
  description: 'Run a morning watchlist scan using rules.json',
  options: {
    rules: {
      type: 'string',
      short: 'r',
      description: 'Path to rules.json (default: project rules.json)',
    },
  },
  handler: ({ rules }) => core.runBrief({ rules_path: rules }),
});

register('session', {
  description: 'Get or save daily brief sessions',
  subcommands: new Map([
    ['get', {
      description: 'Get a saved session (today by default, fallback to previous day)',
      options: {
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format',
        },
      },
      handler: ({ date }) => core.getSession({ date }),
    }],
    ['save', {
      description: 'Save a session brief',
      options: {
        brief: {
          type: 'string',
          short: 'b',
          required: true,
          description: 'Brief text to save',
        },
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format',
        },
      },
      handler: ({ brief, date }) => core.saveSession({ brief, date }),
    }],
  ]),
});

