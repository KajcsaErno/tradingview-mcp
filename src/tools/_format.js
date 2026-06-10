/**
 * Shared MCP response formatting helper.
 * All tool files use this instead of manually constructing MCP responses.
 */
export function jsonResult(obj, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Register an MCP tool with the standard try/catch → jsonResult boilerplate.
 * `handler(args)` should return (or resolve to) the core result object;
 * thrown errors become `{ success: false, error }` with the MCP isError flag.
 */
export function registerTool(server, name, description, schema, handler) {
    server.tool(name, description, schema, async (args) => {
        try {
            return jsonResult(await handler(args));
        } catch (err) {
            return jsonResult({success: false, error: err.message}, true);
        }
    });
}
