import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { validateParsedAlert } from "./schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let policiesCache = null;

function getPoliciesPath() {
  // Allow policies path to be configured via environment variable
  if (process.env.POLICIES_PATH) {
    return resolve(process.env.POLICIES_PATH);
  }
  
  // Default to config/policies.json in project root
  // Get project root by going up from src/parser
  const projectRoot = resolve(__dirname, "../..");
  const defaultPath = join(projectRoot, "config", "policies.json");
  
  // Fallback to old location for backward compatibility
  const fallbackPath = join(__dirname, "policies.json");
  
  if (existsSync(defaultPath)) {
    return defaultPath;
  }
  
  if (existsSync(fallbackPath)) {
    console.warn(`Warning: Using legacy policies.json location at ${fallbackPath}. Please move it to config/policies.json`);
    return fallbackPath;
  }
  
  throw new Error(
    `Policies file not found. Please create config/policies.json or set POLICIES_PATH environment variable.\n` +
    `You can copy config/policies.json.example as a starting point.`
  );
}

function loadPolicies() {
  if (policiesCache) {
    return policiesCache;
  }
  
  const policiesPath = getPoliciesPath();
  
  if (!existsSync(policiesPath)) {
    throw new Error(
      `Policies file not found at ${policiesPath}.\n` +
      `Please create it or set POLICIES_PATH environment variable to point to your policies file.\n` +
      `You can copy config/policies.json.example as a starting point.`
    );
  }
  
  try {
    const policiesData = JSON.parse(readFileSync(policiesPath, "utf-8"));
    
    if (!policiesData.policies || !Array.isArray(policiesData.policies)) {
      throw new Error("Policies file must contain a 'policies' array");
    }
    
    policiesCache = policiesData.policies;
    return policiesCache;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Policies file not found at ${policiesPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in policies file at ${policiesPath}: ${error.message}`);
    }
    throw error;
  }
}

function applyPattern(pattern, text) {
  if (pattern.type === "regex") {
    const regex = new RegExp(pattern.pattern, "i");
    const match = text.match(regex);
    
    if (!match) {
      return null;
    }
    
    const extracted = {};
    if (pattern.capture_groups) {
      for (const [key, groupIndex] of Object.entries(pattern.capture_groups)) {
        const value = match[parseInt(groupIndex)];
        if (value !== undefined) {
          // Try to convert to number if it looks like a number
          if (key.includes("percent") || key.includes("threshold") || key.includes("value")) {
            extracted[key] = Number(value);
          } else {
            extracted[key] = value;
          }
        }
      }
    }
    return extracted;
  }
  
  // Future: support other pattern types (keyword, fuzzy match, etc.)
  return null;
}

function tryPolicyParsing(text) {
  const policies = loadPolicies();
  
  for (const policy of policies) {
    const extracted = {};
    let allPatternsMatched = true;
    
    // Try to match all patterns in the policy
    for (const pattern of policy.patterns) {
      const result = applyPattern(pattern, text);
      if (result === null) {
        allPatternsMatched = false;
        break;
      }
      Object.assign(extracted, result);
    }
    
    if (allPatternsMatched) {
      // Merge with extraction rules
      const parsed = {
        ...policy.extraction_rules,
        ...extracted
      };
      
      return {
        parsed: validateParsedAlert(parsed),
        policy,
        matched: true
      };
    }
  }
  
  return { matched: false };
}

async function tryLLMWithModel(ollamaUrl, model, prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
  
  try {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: "You are a JSON parser. Always return valid JSON only, no markdown formatting, no code blocks." },
          { role: "user", content: prompt }
        ],
        stream: false,
        options: {
          temperature: 0.1
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      try {
        const errorJson = JSON.parse(errorText);
        const errorDetail = errorJson.error || errorText;
        // If it's an EOF error, return null to signal we should try another model
        if (errorDetail.includes("EOF") || errorText.includes("EOF")) {
          return { shouldRetry: true, error: `Model ${model} returned EOF error` };
        }
        throw new Error(`Ollama API error: ${response.status} - ${errorDetail}`);
      } catch (parseError) {
        if (parseError.message.includes("EOF")) {
          return { shouldRetry: true, error: `Model ${model} returned EOF error` };
        }
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
      }
    }
    
    const data = await response.json();
    let content = data.message?.content || data.response || "";
    
    if (!content) {
      throw new Error("Empty response from Ollama");
    }
    
    // Clean up the response - remove markdown code blocks if present
    content = content.trim();
    if (content.startsWith("```json")) {
      content = content.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (content.startsWith("```")) {
      content = content.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    
    // Try to extract JSON if it's embedded in text
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      content = jsonMatch[0];
    }
    
    const parsed = JSON.parse(content);
    return {
      parsed: validateParsedAlert(parsed),
      matched: true
    };
  } catch (fetchError) {
    clearTimeout(timeoutId);
    if (fetchError.name === "AbortError") {
      return { shouldRetry: true, error: `Request to ${model} timed out` };
    }
    // Check if it's an EOF-related error
    if (fetchError.message?.includes("EOF")) {
      return { shouldRetry: true, error: fetchError.message };
    }
    throw fetchError;
  }
}

async function tryLLMParsing(text) {
  // Get Ollama configuration
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  let primaryModel = process.env.OLLAMA_MODEL || "llama3";
  
  // Ensure model name includes :latest tag if no tag is specified
  if (!primaryModel.includes(":")) {
    primaryModel = `${primaryModel}:latest`;
  }
  
  // First, verify Ollama is accessible and get available models
  let availableModels = [];
  try {
    const healthController = new AbortController();
    const healthTimeout = setTimeout(() => healthController.abort(), 5000);
    const healthCheck = await fetch(`${ollamaUrl}/api/tags`, { 
      signal: healthController.signal 
    });
    clearTimeout(healthTimeout);
    if (!healthCheck.ok) {
      return { matched: false, error: `Ollama server not accessible at ${ollamaUrl}` };
    }
    const modelsData = await healthCheck.json();
    availableModels = modelsData.models?.map(m => m.name) || [];
    
    if (availableModels.length === 0) {
      return { matched: false, error: "No models available in Ollama. Pull a model first: ollama pull llama3" };
    }
  } catch (healthError) {
    if (healthError.name === "AbortError") {
      return { 
        matched: false, 
        error: `Ollama health check timed out. Make sure Ollama is running at ${ollamaUrl}` 
      };
    }
    return { 
      matched: false, 
      error: `Cannot connect to Ollama at ${ollamaUrl}. Make sure Ollama is running: ${healthError.message}` 
    };
  }
  
  // Build the prompt
  const policies = loadPolicies();
  const policyExamples = policies.map(p => ({
    alert_type: p.alert_type,
    name: p.name,
    sample_texts: p.sample_texts
  }));
  
  const prompt = `You are an alert parser. Parse the following alert text and extract structured information.

Available alert types and examples:
${JSON.stringify(policyExamples, null, 2)}

Alert text to parse:
${text}

Return a JSON object with the following structure:
{
  "alert_type": "string (one of: ${policies.map(p => p.alert_type).join(", ")})",
  "project_id": "string or null",
  "instance_name": "string or null",
  "metric_labels": {},
  "threshold_percent": "number or null",
  "value_percent": "number or null",
  "policy_name": "string or null",
  "condition_name": "string or null",
  "violation_started_raw": "string or null",
  "gcp_alert_url": "string or null",
  "confidence": 0.7,
  "missing_fields": ["array of missing field names"],
  "parse_method": "llm"
}

Only return valid JSON, no other text.`;

  // Build list of models to try: primary first, then alternatives
  const modelsToTry = [primaryModel];
  // Add other available models as fallbacks (excluding embedding models)
  for (const model of availableModels) {
    if (model !== primaryModel && !model.includes("embed") && !modelsToTry.includes(model)) {
      modelsToTry.push(model);
    }
  }
  
  // Try each model until one works
  const errors = [];
  for (const model of modelsToTry) {
    try {
      const result = await tryLLMWithModel(ollamaUrl, model, prompt);
      if (result.matched) {
        return {
          parsed: result.parsed,
          matched: true,
          policy: null, // LLM parsing doesn't have a specific policy
          modelUsed: model
        };
      }
      if (result.shouldRetry) {
        errors.push(`${model}: ${result.error}`);
        // Continue to next model
        continue;
      }
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
      // Continue to next model
      continue;
    }
  }
  
  // All models failed
  console.error("Ollama LLM parsing failed for all models:", errors);
  return { 
    matched: false, 
    error: `All models failed. Errors: ${errors.join("; ")}. Policy-based parsing is recommended for reliable results.` 
  };
}

export async function parseAlert(text) {
  // First, try policy-based parsing
  const policyResult = tryPolicyParsing(text);
  if (policyResult.matched) {
    return policyResult;
  }
  
  // If policy parsing fails, try LLM parsing
  const llmResult = await tryLLMParsing(text);
  if (llmResult.matched) {
    return llmResult;
  }
  
  // If both fail, return error
  return {
    matched: false,
    error: "Could not parse alert with policy or LLM",
    parsed: null
  };
}

export function reloadPolicies() {
  policiesCache = null;
  return loadPolicies();
}

