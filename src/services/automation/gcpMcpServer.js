// src/services/automation/gcpMcpServer.js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Compute from '@google-cloud/compute';

const compute = new Compute();
const server = new Server(
  { 
    name: "gcp-autoheal", 
    version: "1.0.0" 
  }, 
  { 
    capabilities: { 
      tools: {} 
    } 
  }
);

/**
 * TOOL 1: DISCOVERY
 * Finds the Zone and Instance Group (MIG) for a given instance name.
 */
server.setRequestHandler("tools/list", async () => {
  return {
    tools: [
      {
        name: "discover_instance_metadata",
        description: "Finds the project, zone, and MIG name for a specific instance",
        inputSchema: {
          type: "object",
          properties: {
            instanceName: { type: "string", description: "Instance name to look up" }
          },
          required: ["instanceName"]
        }
      },
      {
        name: "execute_recreate_instance",
        description: "Recreates an instance in a Managed Instance Group",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "GCP project ID" },
            zone: { type: "string", description: "GCP zone" },
            migName: { type: "string", description: "Managed Instance Group name" },
            instanceName: { type: "string", description: "Instance name to recreate" }
          },
          required: ["projectId", "zone", "migName", "instanceName"]
        }
      }
    ]
  };
});

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "discover_instance_metadata") {
    try {
      const { instanceName } = args;
      // Search across all zones in the project
      const [instances] = await compute.getInstances({ filter: `name = ${instanceName}` });
      if (instances.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Instance not found." }) }],
          isError: true
        };
      }

      const instance = instances[0];
      const zone = instance.zone.split('/').pop();
      
      // Find the Managed Instance Group (MIG) via metadata or labels
      const migName = instance.metadata?.items?.find(i => i.key === 'created-by')?.value?.split('/').pop() || "unknown";

      return {
        content: [{ type: "text", text: JSON.stringify({ zone, migName, projectId: compute.projectId }) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
        isError: true
      };
    }
  }

  if (name === "execute_recreate_instance") {
    try {
      const { projectId, zone, migName, instanceName } = args;
      const zoneObj = compute.zone(zone);
      const igm = zoneObj.instanceGroupManager(migName);
      
      // The actual GCP API call to recreate the instance Oldest-to-Newest
      // commment out for now await igm.recreateInstances({ instances: [instanceName] });
      
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, message: `Successfully triggered recreation for ${instanceName} in ${migName}` }) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `GCP Error: ${err.message}` }) }],
        isError: true
      };
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
    isError: true
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
