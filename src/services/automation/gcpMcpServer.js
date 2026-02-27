// src/services/automation/gcpMcpServer.js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Octokit } from "@octokit/rest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execAsync = promisify(exec);
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
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "execute_gcloud_command",
        description: "Executes an arbitrary gcloud command. Use this for executing gcloud commands from action templates.",
        inputSchema: {
          type: "object",
          properties: {
            command: { 
              type: "string", 
              description: "The full gcloud command to execute (e.g., 'gcloud compute ssh instance-name --zone=us-central1-a --project=my-project --command=\"ls -la\"')" 
            }
          },
          required: ["command"]
        }
      },
      {
        name: "execute_gcloud_scale_up",
        description: "Executes a gcloud command to scale up instances. Uses the exact command from policy.",
        inputSchema: {
          type: "object",
          properties: {
            serviceName: {
              type: "string",
              description: "Service name to scale up (optional, used for logging)"
            },
            gcloudCommand: {
              type: "string",
              description: "The exact gcloud command from policy to execute (no template replacement needed)"
            }
          },
          required: ["gcloudCommand"]
        }
      },
      {
        name: "generate_terragrunt_autoscaler_diff",
        description: "Generates a terragrunt.hcl autoscaler configuration diff for scaling up servers. Takes service name, schedule, and scaling parameters.",
        inputSchema: {
          type: "object",
          properties: {
            serviceName: { 
              type: "string", 
              description: "Name of the service (e.g., 'api', 'gacha-api', 'login-api')" 
            },
            scheduleName: { 
              type: "string", 
              description: "Name for the autoscaler schedule (e.g., 'mm-comp-7-star')" 
            },
            scheduleExpression: { 
              type: "string", 
              description: "Schedule expression (e.g., 's(local.sch_1730_utc) 12 $(local.sch_jan_2026)')" 
            },
            durationSec: { 
              type: "string", 
              description: "Duration in seconds variable (e.g., 'local.sch_02_hours')" 
            },
            minReplicas: { 
              type: "string", 
              description: "Minimum replicas variable (e.g., 'local.sch_moderate_high')" 
            },
            timeZone: { 
              type: "string", 
              description: "Time zone (default: 'Etc/UTC')" 
            }
          },
          required: ["serviceName", "scheduleName", "scheduleExpression", "durationSec", "minReplicas"]
        }
      },
      {
        name: "generate_machine_type_diff",
        description: "Generates a terragrunt.hcl diff for changing VM machine type (to add memory). Takes environment, service name, current and target machine types.",
        inputSchema: {
          type: "object",
          properties: {
            environment: { 
              type: "string", 
              description: "Environment name (e.g., 'qaprod', 'production')" 
            },
            serviceName: { 
              type: "string", 
              description: "Service name (e.g., 'matchmakerd_drb', 'api')" 
            },
            currentMachineType: { 
              type: "string", 
              description: "Current machine type (e.g., 'c2d-standard-2')" 
            },
            targetMachineType: { 
              type: "string", 
              description: "Target machine type (e.g., 'c2d-standard-4')" 
            }
          },
          required: ["environment", "serviceName", "currentMachineType", "targetMachineType"]
        }
      },
      {
        name: "generate_scaling_schedule_yaml_diff",
        description: "Generates a YAML diff for scaling schedule configuration from SCALEPRREQUEST format. Uses bash script. Takes schedule (mm hh dd MM * YYYY), duration in seconds, and name.",
        inputSchema: {
          type: "object",
          properties: {
            schedule: {
              type: "string",
              description: "Schedule in format 'mm hh dd MM * YYYY' (e.g., '30 17 4 02 * 2026' for 17:30 Feb 4th 2026 UTC)"
            },
            duration: {
              type: "number",
              description: "Duration in seconds (e.g., 7200 for 2 hours)"
            },
            name: {
              type: "string",
              description: "Scale up name (e.g., 'big sale')"
            }
          },
          required: ["schedule", "duration", "name"]
        }
      },
      {
        name: "create_scaling_schedule_pr",
        description: "Creates a PR via GitHub API by appending a scaling schedule to the YAML file. Same params as generate_scaling_schedule_yaml_diff plus repo. Requires GITHUB_TOKEN.",
        inputSchema: {
          type: "object",
          properties: {
            schedule: {
              type: "string",
              description: "Schedule in format 'mm hh dd MM * YYYY' (e.g., '30 17 4 02 * 2026')"
            },
            duration: {
              type: "number",
              description: "Duration in seconds (e.g., 7200 for 2 hours)"
            },
            name: {
              type: "string",
              description: "Scale up name (e.g., 'big sale')"
            },
            owner: {
              type: "string",
              description: "GitHub repo owner (e.g., 'myorg')"
            },
            repo: {
              type: "string",
              description: "GitHub repo name (e.g., 'mcoc-production')"
            },
            baseBranch: {
              type: "string",
              description: "Base branch to create PR from (default: master)"
            },
            filePath: {
              type: "string",
              description: "Path to YAML file (default: production/scaling_schedules/api_disconnect_gacha_login_tmt.yaml)"
            }
          },
          required: ["schedule", "duration", "name", "owner", "repo"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "execute_gcloud_command") {
    try {
      const { command } = args;
      
      // Security: Only allow gcloud commands
      if (!command.trim().startsWith("gcloud")) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Only gcloud commands are allowed" }) }],
          isError: true
        };
      }

      // Execute the gcloud command
      console.log(`[MCP Server] Executing gcloud command: ${command}`);
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 300000 // 5 minute timeout
      });

      const output = stdout || stderr || "";
      
      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            success: true, 
            command,
            stdout: output,
            message: `Command executed successfully` 
          }) 
        }]
      };
    } catch (err) {
      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            error: `Command execution failed: ${err.message}`,
            stderr: err.stderr || "",
            stdout: err.stdout || ""
          }) 
        }],
        isError: true
      };
    }
  }

  if (name === "execute_gcloud_scale_up") {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [MCP Server] execute_gcloud_scale_up called`);
    console.log(`[${timestamp}] [MCP Server] Arguments:`, JSON.stringify(args, null, 2));
    
    try {
      const { serviceName, gcloudCommand } = args;
      
      if (!gcloudCommand || !gcloudCommand.trim()) {
        console.log(`[${timestamp}] [MCP Server] ERROR: gcloud command is required`);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              error: "gcloud command is required"
            }) 
          }],
          isError: true
        };
      }
      
      // Use the command directly from policy (no template replacement)
      const gcloudCmd = gcloudCommand.trim();
      
      console.log(`[${timestamp}] [MCP Server] Executing scale-up command for service: ${serviceName || 'unknown'}`);
      console.log(`[${timestamp}] [MCP Server] Command: ${gcloudCmd}`);
      
      // For now, return the command that would be executed
      // Uncomment the execAsync call below when you're ready to execute
      /*
      console.log(`[${timestamp}] [MCP Server] About to execute command via execAsync...`);
      const { stdout, stderr } = await execAsync(gcloudCmd, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000
      });
      console.log(`[${timestamp}] [MCP Server] Command executed. stdout length: ${stdout?.length || 0}, stderr length: ${stderr?.length || 0}`);
      */
      
      console.log(`[${timestamp}] [MCP Server] Returning success response (command not actually executed - placeholder mode)`);
      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            success: true, 
            command: gcloudCmd,
            message: `Scale-up command prepared and ready to execute.`
          }) 
        }]
      };
    } catch (err) {
      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            error: `Scale-up command failed: ${err.message}`
          }) 
        }],
        isError: true
      };
    }
  }

  if (name === "generate_terragrunt_autoscaler_diff") {
    try {
      const { 
        serviceName, 
        scheduleName, 
        scheduleExpression, 
        durationSec, 
        minReplicas,
        timeZone = "Etc/UTC"
      } = args;

      // Generate the terragrunt.hcl autoscaler block (with proper indentation)
      const autoscalerBlock = `  autoscaler {
    name = "${scheduleName}"
    schedule = "${scheduleExpression}"
    duration_sec = ${durationSec}
    min_required_replicas = ${minReplicas}
    time_zone = "${timeZone}"
  }
  // Autoscaler`;

      // Generate git diff format similar to GitHub PR
      // The @@ line shows: @@ -old_start,old_count +new_start,new_count @@
      // We'll use a placeholder line number (283) as shown in the example
      const diff = `--- a/production/${serviceName}/terragrunt.hcl
+++ b/production/${serviceName}/terragrunt.hcl
@@ -283,6 +283,14 @@
+${autoscalerBlock}`;

      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            success: true, 
            serviceName,
            diff,
            autoscalerBlock,
            message: `Generated terragrunt autoscaler configuration diff for ${serviceName}` 
          }) 
        }]
      };
    } catch (err) {
      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            error: `Failed to generate diff: ${err.message}` 
          }) 
        }],
        isError: true
      };
    }
  }

  if (name === "generate_machine_type_diff") {
    try {
      const { 
        environment, 
        serviceName, 
        currentMachineType, 
        targetMachineType 
      } = args;

      // Generate the git diff format for machine type change
      // Based on the example: diff shows changing machine_type in instance_template
      const diff = `diff --git a/${environment}/${serviceName}/terragrunt.hcl b/${environment}/${serviceName}/terragrunt.hcl
index cce6ec39..d03993cc 100644
--- a/${environment}/${serviceName}/terragrunt.hcl
+++ b/${environment}/${serviceName}/terragrunt.hcl
@@ -90,7 +90,7 @@ inputs = merge(
     // Instance Template
     instance_template = {
       name         = local.tf_var_files.name
-      machine_type = "${currentMachineType}"
+      machine_type = "${targetMachineType}"
       tags         = local.tf_var_files.default_network_tags
       labels = {
         game        = local.tf_var_files.product`;

      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            success: true, 
            environment,
            serviceName,
            currentMachineType,
            targetMachineType,
            diff,
            message: `Generated machine type change diff for ${environment}/${serviceName}` 
          }) 
        }]
      };
    } catch (err) {
      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            error: `Failed to generate machine type diff: ${err.message}` 
          }) 
        }],
        isError: true
      };
    }
  }

  if (name === "generate_scaling_schedule_yaml_diff") {
    try {
      const { schedule, duration, name: scheduleName } = args;
      // Hardcoded defaults
      const serviceName = "api";
      const environment = "production";
      
      if (!schedule || !duration || !scheduleName) {
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              error: "Missing required parameters: schedule, duration, name" 
            }) 
          }],
          isError: true
        };
      }
      
      // Use the schedule string directly without validation
      // User input: "mm hh dd MM * YYYY" format (e.g., "30 17 4 02 * 2026")
      const scheduleString = schedule.trim();
      
      // Generate the YAML content
      const fileName = `api_disconnect_gacha_login_tmt.yaml`;
      const yamlContent = `---
# ${scheduleName}

- name                  : ${scheduleName}
  schedule              : ${scheduleString}
  duration_sec          : ${duration}
  min_required_replicas : \${sch_high}
  time_zone             : Etc/UTC`;
      
      // Generate git diff format
      const diff = `diff --git a/production/scaling_schedules/${fileName} b/production/scaling_schedules/${fileName}
index 71c5e0f35504..f40f522f9942 100644
--- a/production/scaling_schedules/${fileName}
+++ b/production/scaling_schedules/${fileName}
@@ -1 +1,38 @@
 ---
+# ${scheduleName}
+
+- name                  : ${scheduleName}
+  schedule              : ${scheduleString}
+  duration_sec          : ${duration}
+  min_required_replicas : \${sch_high}
+  time_zone             : Etc/UTC`;

      // Read the script template
      const scriptPath = join(__dirname, "../../../config/scale_pr.sh");
      let scriptContent = readFileSync(scriptPath, "utf-8");
      
      // Replace placeholders with user input
      const ticketNumber = scheduleName.trim();
      scriptContent = scriptContent.replace(/REPLACEWITHSCHEDULENAME/g, ticketNumber);
      scriptContent = scriptContent.replace(/REPLACEWITHUSERINPUTSCHEDULE/g, scheduleString);
      scriptContent = scriptContent.replace(/REPLACEWITHUSERINPUTDURATION/g, String(duration));
      scriptContent = scriptContent.replace(/# big sale/g, `# ${ticketNumber}`);
      scriptContent = scriptContent.replace(/feat: append big sale scaling schedule/g, `feat: append ${ticketNumber} scaling schedule`);
      
      // Write to a temporary script file
      const tempScriptPath = join(__dirname, "../../../config/scale_pr_temp.sh");
      writeFileSync(tempScriptPath, scriptContent, { mode: 0o755 });
      
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [MCP Server] Executing script with replacements:`);
      console.log(`[${timestamp}] [MCP Server]   BRANCH_NAME: ${ticketNumber}`);
      console.log(`[${timestamp}] [MCP Server]   SCHEDULE: ${scheduleString}`);
      console.log(`[${timestamp}] [MCP Server]   DURATION: ${duration}`);
      
      // Execute the script
      const { stdout, stderr } = await execAsync(`bash ${tempScriptPath}`, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 300000 // 5 minute timeout
      });
      
      // Clean up temp script
      try {
        unlinkSync(tempScriptPath);
      } catch (cleanupErr) {
        console.warn(`[${timestamp}] [MCP Server] Failed to cleanup temp script: ${cleanupErr.message}`);
      }
      
      console.log(`[${timestamp}] [MCP Server] Script execution completed`);
      console.log(`[${timestamp}] [MCP Server] Stdout length: ${stdout.length}, Stderr length: ${stderr?.length || 0}`);
      
      // Combine stdout and stderr for full output
      const fullOutput = stderr ? `${stdout}\n${stderr}` : stdout;
      
      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            success: true, 
            ticketNumber,
            schedule: scheduleString,
            duration,
            output: fullOutput,
            message: "Script execution completed" 
          }) 
        }]
      };
    } catch (err) {
      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            error: `Failed to execute scale PR script: ${err.message}`,
            stderr: err.stderr || "",
            stdout: err.stdout || "" 
          }) 
        }],
        isError: true
      };
    }
  }

  if (name === "create_scaling_schedule_pr") {
    const projectId = process.env.GCP_PROJECT_ID || "YOUR_PROJECT_ID";
    const secretManagerUrl = `https://console.cloud.google.com/security/secret-manager/secret/github-token/versions?project=${projectId}`;
    const tokenErrorHint = ` Update the token at: ${secretManagerUrl}`;

    try {
      const {
        schedule,
        duration,
        name: scheduleName,
        owner,
        repo,
        baseBranch = "master",
        filePath = "production/scaling_schedules/api_disconnect_gacha_login_tmt.yaml"
      } = args;

      if (!schedule || !duration || !scheduleName || !owner || !repo) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: "Missing required parameters: schedule, duration, name, owner, repo" })
          }],
          isError: true
        };
      }

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `GITHUB_TOKEN is not set or empty.${tokenErrorHint}`
            })
          }],
          isError: true
        };
      }

      const scheduleString = String(schedule).trim();
      const ticketNumber = String(scheduleName).trim();
      const shortTimestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12); // YYYYMMDDHHmm
      const branchName = `${ticketNumber}-${shortTimestamp}`;
      const octokit = new Octokit({ auth: token });

      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [MCP Server] create_scaling_schedule_pr: ${owner}/${repo}, branch: ${branchName}`);

      // 1. Get repo metadata to resolve actual default branch (avoids 404 when repo uses 'main' vs 'master')
      const { data: repoData } = await octokit.rest.repos.get({
        owner,
        repo
      });
      // Use repo's actual default branch when baseBranch is default "master" (avoids 404 for repos using "main")
      const effectiveBaseBranch = (baseBranch === "master" || !baseBranch)
        ? (repoData.default_branch || "main")
        : baseBranch;
      console.log(`[${timestamp}] [MCP Server] Using base branch: ${effectiveBaseBranch} (repo default: ${repoData.default_branch})`);

      // 2. Get base branch ref
      const { data: refData } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${effectiveBaseBranch}`
      });
      const baseSha = refData.object.sha;

      // 2. Create new branch from base
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: baseSha
      });

      // 3. Get current file content (or create from scratch if missing)
      let currentContent = "";
      let fileSha = null;
      try {
        const { data: fileData } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: filePath,
          ref: effectiveBaseBranch
        });
        if (Array.isArray(fileData)) {
          throw new Error(`Path ${filePath} is a directory, not a file`);
        }
        currentContent = Buffer.from(fileData.content, "base64").toString("utf-8");
        fileSha = fileData.sha;
      } catch (e) {
        if (e.response?.status === 404) {
          currentContent = "---\n";
        } else {
          throw e;
        }
      }

      const appendBlock = `

# ${ticketNumber}
- name                  : ${ticketNumber}
  schedule              : ${scheduleString}
  duration_sec          : ${duration}
  min_required_replicas : \${sch_high}
  time_zone             : Etc/UTC`;
      const newContent = currentContent + appendBlock;

      // 4. Create or update file on new branch
      const updateParams = {
        owner,
        repo,
        path: filePath,
        message: `feat: append ${ticketNumber} scaling schedule`,
        content: Buffer.from(newContent).toString("base64"),
        branch: branchName
      };
      if (fileSha) {
        updateParams.sha = fileSha;
      }
      await octokit.rest.repos.createOrUpdateFileContents(updateParams);

      // 5. Create PR
      const { data: pr } = await octokit.rest.pulls.create({
        owner,
        repo,
        title: `feat: append ${ticketNumber} scaling schedule`,
        head: branchName,
        base: effectiveBaseBranch,
        body: `Adds scaling schedule for ${ticketNumber}.

- **Schedule**: \`${scheduleString}\`
- **Duration**: ${duration} seconds
- **File**: \`${filePath}\``
      });

      const prUrl = pr.html_url;
      console.log(`[${timestamp}] [MCP Server] PR created: ${prUrl}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            ticketNumber,
            schedule: scheduleString,
            duration,
            prUrl,
            prNumber: pr.number,
            message: `PR created: ${prUrl}`
          })
        }]
      };
    } catch (err) {
      const timestamp = new Date().toISOString();
      console.error(`[${timestamp}] [MCP Server] create_scaling_schedule_pr failed:`, err.message);
      let errorMsg = err.message;
      // Octokit uses err.status; axios-style uses err.response?.status (401 = expired/invalid token)
      const status = err.status ?? err.response?.status;
      const bodyMsg = err.response?.data?.message ?? err.response?.data?.error ?? "";
      const isTokenError = status === 401 || /bad credentials|token.*expired|invalid/i.test(String(bodyMsg));
      if (isTokenError) {
        errorMsg += ` (Token expired or invalid. Update at: ${secretManagerUrl})`;
      } else if (status === 403 || status === 404) {
        errorMsg += ` (GitHub auth may lack access. Update token if needed: ${secretManagerUrl})`;
      } else if (status >= 400) {
        errorMsg += ` | Update token if needed: ${secretManagerUrl}`;
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: `Failed to create scaling schedule PR: ${errorMsg}`,
            details: err.response?.data || err.toString()
          })
        }],
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
