from mcp.server.mcpserver.exceptions import ToolError


class DevOpsError(ToolError):
    """An error whose message is safe and useful to show to the model.

    The MCP SDK only forwards the text of `ToolError`s to the client; any other
    exception is reported as an opaque failure. Everything this package raises on
    purpose is a `DevOpsError` so the model can see what went wrong and react.
    """
