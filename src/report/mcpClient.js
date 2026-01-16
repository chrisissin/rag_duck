/**
 * MCP (Model Context Protocol) Client
 * 
 * This module provides integration with MCP servers for automating actions.
 * MCP allows AI assistants to interact with external tools and services.
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mcpClient = null;
let mcpSDKLoaded = false;
let ClientClass = null;
let StdioClientTransportClass = null;

/**
 * Lazy load MCP SDK
 */
async function loadMCPSDK() {
  if (mcpSDKLoaded) {
    return ClientClass !== null && StdioClientTransportClass !== null;
  }
  
  try {
    const mcpSDK = await import("@modelcontextprotocol/sdk/client/index.js");
    const transportSDK = await import("@modelcontextprotocol/sdk/client/stdio.js");
    ClientClass = mcpSDK.Client;
    StdioClientTransportClass = transportSDK.StdioClientTransport;
    mcpSDKLoaded = true;
    return true;
  } catch (error) {
    console.warn("MCP SDK not available. MCP features will be disabled. Install with: npm install @modelcontextprotocol/sdk");
    ClientClass = null;
    StdioClientTransportClass = null;
    mcpSDKLoaded = true;
    return false;
  }
}

/**
 * Initialize MCP client connection
 */
async function getMCPClient() {
  const sdkAvailable = await loadMCPSDK();
  
  if (!sdkAvailable) {
    throw new Error("MCP SDK not installed. Run: npm install @modelcontextprotocol/sdk");
  }
  
  if (mcpClient) {
    return mcpClient;
  }

  const mcpServerPath = join(__dirname, "../services/automation/gcpMcpServer.js");

  // Create client transport
  const transport = new StdioClientTransportClass({
    command: "node",
    args: [mcpServerPath]
  });

  mcpClient = new ClientClass(
    {
      name: "slack-rag-bot-mcp-client",
      version: "1.0.0"
    },
    {
      capabilities: {}
    }
  );

  await mcpClient.connect(transport);
  
  return mcpClient;
}

/**
 * Execute MCP action by calling the MCP server tools
 */
export async function executeMCPAction(action, parsed) {
  // Check if MCP is enabled
  if (process.env.ENABLE_MCP !== "true") {
    throw new Error("MCP is not enabled. Set ENABLE_MCP=true to enable.");
  }

  try {
    const instanceName = parsed.instance_name;
    const projectId = parsed.project_id;
    
    if (!instanceName) {
      throw new Error("Instance name is required for MCP action");
    }

    const client = await getMCPClient();

    // First, discover instance metadata
    const metadataResult = await client.callTool({
      name: "discover_instance_metadata",
      arguments: { instanceName }
    });

    if (metadataResult.isError || !metadataResult.content || metadataResult.content.length === 0) {
      throw new Error(`Failed to discover instance metadata: ${metadataResult.content?.[0]?.text || "Unknown error"}`);
    }

    const metadataText = metadataResult.content[0].text;
    const metadata = JSON.parse(metadataText);
    if (metadata.error) {
      throw new Error(`Failed to discover instance metadata: ${metadata.error}`);
    }

    const { zone, migName, projectId: discoveredProjectId } = metadata;
    const finalProjectId = projectId || discoveredProjectId;

    // Execute the recreate instance action
    const executeResult = await client.callTool({
      name: "execute_recreate_instance",
      arguments: {
        projectId: finalProjectId,
        zone,
        migName,
        instanceName
      }
    });

    if (executeResult.isError || !executeResult.content || executeResult.content.length === 0) {
      throw new Error(`MCP execution failed: ${executeResult.content?.[0]?.text || "Unknown error"}`);
    }

    const executionResultText = executeResult.content[0].text;
    const executionResult = JSON.parse(executionResultText);
    
    return {
      success: executionResult.success !== false && !executionResult.error,
      result: executionResult,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Alternative: Direct command execution via MCP tools
 * This would use MCP SDK if available
 */
export async function executeMCPCommand(command, args = {}) {
  // This is a placeholder for MCP SDK integration
  // Example: Using @modelcontextprotocol/sdk if available
  // 
  // const client = new MCPClient({ serverUrl: process.env.MCP_SERVER_URL });
  // return await client.callTool("execute_command", { command, args });
  
  throw new Error("MCP SDK integration not yet implemented. Use executeMCPAction instead.");
}

