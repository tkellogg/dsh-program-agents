/** Types inferred directly from the official MCP SDK's published schemas. */
import type{z}from'zod';
import type{CallToolRequestParamsSchema,CallToolResultSchema,ListToolsResultSchema,ToolSchema}from'@modelcontextprotocol/core';
export type CallToolRequestParams=z.infer<typeof CallToolRequestParamsSchema>;
export type CallToolResult=z.infer<typeof CallToolResultSchema>;
export type ListToolsResult=z.infer<typeof ListToolsResultSchema>;
export type Tool=z.infer<typeof ToolSchema>;
