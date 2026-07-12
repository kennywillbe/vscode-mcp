# Privacy

`vscode-mcp` does not include telemetry, analytics, advertising, crash reporting, or a
project-operated network service. The extension and server communicate locally through
authenticated user-scoped IPC. They do not send workspace contents, editor state,
credentials, or usage data to the project maintainers.

The MCP client and model selected by the user are separate products. They may transmit
content returned by `vscode-mcp` according to their own privacy, retention, and model
settings. Users should review those settings before enabling a workspace.

VS Code Marketplace, GitHub, and the user's extension update configuration operate under
their respective privacy policies. This project does not receive additional telemetry
from the extension.

Security-sensitive reports must follow [SECURITY.md](./SECURITY.md).
