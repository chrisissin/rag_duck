import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { validateParsedAlert } from "./schema.js";
import { fetchWithRetry } from "../rag/ollama.js";

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
    // If policy has no patterns, skip it (it relies on LLM parsing)
    if (!policy.patterns || policy.patterns.length === 0) {
      continue;
    }
    
    
    const extracted = {};
    let atLeastOnePatternMatched = false;
    
    // Try to match patterns in the policy
    // For policies that need multiple fields (like scalepr_request), we need to match ALL patterns
    // For policies with alternative patterns, we match ANY pattern
    // Strategy: Try all patterns and collect all matches
    for (const pattern of policy.patterns) {
      const result = applyPattern(pattern, text);
      if (result !== null) {
        atLeastOnePatternMatched = true;
        Object.assign(extracted, result);
        // Don't break - continue to collect all matches for policies that need multiple fields
      }
    }
    
    if (atLeastOnePatternMatched) {
      // Merge with extraction rules, ensuring all required fields are present
      const parsed = {
        ...policy.extraction_rules,
        ...extracted,
        // Ensure required fields are present (even if null/undefined in extraction_rules)
        threshold_percent: extracted.threshold_percent ?? policy.extraction_rules.threshold_percent ?? null,
        value_percent: extracted.value_percent ?? policy.extraction_rules.value_percent ?? null,
        metric_labels: extracted.metric_labels ?? policy.extraction_rules.metric_labels ?? {},
        missing_fields: extracted.missing_fields ?? policy.extraction_rules.missing_fields ?? [],
        confidence: extracted.confidence ?? policy.extraction_rules.confidence ?? 0.7,
        parse_method: extracted.parse_method ?? policy.extraction_rules.parse_method ?? "policy"
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
  const timeoutSec = parseInt(process.env.OLLAMA_PARSER_TIMEOUT_SEC || "60", 10);
  const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);
  
  try {
    const response = await fetchWithRetry(`${ollamaUrl}/api/chat`, {
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
    
    // If alert_type is null, the LLM couldn't identify it as an alert
    // Treat this as "not matched" so we can fall back to RAG
    if (parsed.alert_type === null || parsed.alert_type === undefined) {
      return {
        matched: false
      };
    }
    
    // Validate the parsed response
    try {
      const validated = validateParsedAlert(parsed);
      return {
        parsed: validated,
        matched: true
      };
    } catch (validationError) {
      // If validation fails, treat it as a retryable error
      // Log the actual response for debugging
      console.warn(`Model ${model} returned invalid response:`, JSON.stringify(parsed, null, 2));
      return { 
        shouldRetry: true, 
        error: `Validation failed: ${validationError.message}` 
      };
    }
  } catch (fetchError) {
    clearTimeout(timeoutId);
    if (fetchError.name === "AbortError") {
      return { shouldRetry: true, error: `Request to ${model} timed out` };
    }
    // Check if it's an EOF-related error
    if (fetchError.message?.includes("EOF")) {
      return { shouldRetry: true, error: fetchError.message };
    }
    // Check if it's a JSON parse error
    if (fetchError instanceof SyntaxError) {
      return { 
        matched: false,
        error: `Invalid JSON response from ${model}: ${fetchError.message}` 
      };
    }
    throw fetchError;
  }
}

async function tryLLMParsing(text) {
  // Get Ollama configuration
  const ollamaUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL || "http://localhost:11434";
  const primaryModel = process.env.OLLAMA_MODEL || "llama3.1";

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
      return { matched: false, error: "No models available in Ollama. Pull a model first: ollama pull llama3.1" };
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
  "parse_method": "llm",
  "user_intent": "string describing the user's intent (if scaling_intent_detected)",
  "service_name": "string or null (service name like 'api', 'gacha-api', 'login-api' if mentioned or can be inferred)",
  "schedule_name": "string or null (autoscaler schedule name, can be generated if not specified)",
  "schedule_expression": "string or null (schedule expression like 's(local.sch_1730_utc) 12 $(local.sch_jan_2026)')",
  "duration_sec": "string or null (duration variable like 'local.sch_02_hours')",
  "min_replicas": "string or null (min replicas variable like 'local.sch_moderate_high')",
  "mig_name": "string or null (managed instance group name if mentioned)",
  "region": "string or null (GCP region like 'us-central1' if mentioned)",

}

Special instructions:
- ONLY set alert_type to "scaling_intent_detected" if the user EXPLICITLY mentions:
  * Scaling up servers/infrastructure (e.g., "we need to scale up", "add more servers", "increase capacity")
  * Traffic/load issues requiring more resources (e.g., "we're getting crushed by traffic", "servers are overloaded")
  * Explicit requests for more compute power (e.g., "we need more power", "spin up more instances")
- DO NOT set scaling_intent_detected for:
  * General questions about infrastructure
  * Questions about existing systems
  * Requests for information or status checks
  * Performance issues that don't explicitly mention scaling or memory
  * If the user is just asking "what should I do?" without mentioning scaling or memory
- If unsure whether it's a scaling request, set alert_type to null (not an alert)
- For scaling_intent_detected, try to extract service_name from context. If not mentioned, use "api" as default
- For scaling_intent_detected, set user_intent to a brief description of what the user wants
- For cpu_utilization_high and game_performance_issue, extract mig_name and region if mentioned (required for action execution)
- If schedule details are not mentioned, you can leave them as null (defaults will be used)

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
        // Try to find matching policy by alert_type
        const policies = loadPolicies();
        const matchingPolicy = policies.find(p => p.alert_type === result.parsed.alert_type);
        
        return {
          parsed: result.parsed,
          matched: true,
          policy: matchingPolicy || null,
          modelUsed: model
        };
      }
      // If model determined it's not an alert (alert_type: null), return immediately
      if (result.matched === false) {
        return {
          matched: false
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
  // Check if detection features are disabled
  const disableScalingIntent = process.env.DISABLE_SCALING_INTENT_DETECTION === "true";
  
  // First, try policy-based parsing
  const policyResult = tryPolicyParsing(text);
  if (policyResult.matched) {
    // Skip scaling intent detection if disabled
    if (disableScalingIntent && policyResult.policy?.alert_type === "scaling_intent_detected") {
      return { matched: false };
    }
    // Skip add_memory_to_vm (not supported)
    if (policyResult.policy?.alert_type === "add_memory_to_vm") {
      return { matched: false };
    }
    
    // For certain alert types, check if critical fields are missing and use LLM to extract them
    const parsed = policyResult.parsed;
    const alertType = parsed?.alert_type;
    
    if (alertType === "cpu_utilization_high" || alertType === "game_performance_issue") {
      // Check if critical fields are missing (mig_name and region needed for action execution)
      const hasMigName = parsed?.mig_name || parsed?.migName;
      const hasRegion = parsed?.region;
      
      if (!hasMigName || !hasRegion) {
        // Fall through to LLM parsing to extract missing fields
        console.log(`Policy matched but missing critical fields (mig_name, region) for ${alertType}, using LLM to extract...`);
      } else {
        // All fields present, return policy result
        return policyResult;
      }
    } else if (alertType === "scaling_intent_detected") {
      // For scaling intent, service_name is helpful but not critical, so we can return policy result
      return policyResult;
    } else {
      // For other alert types, return policy result
      return policyResult;
    }
  }
  
  // If policy parsing fails OR policy matched but needs LLM for field extraction, try LLM parsing
  const llmResult = await tryLLMParsing(text);
  if (llmResult.matched) {
    // Skip scaling intent detection if disabled
    if (disableScalingIntent && llmResult.parsed?.alert_type === "scaling_intent_detected") {
      return { matched: false };
    }
    // Skip add_memory_to_vm (not supported)
    if (llmResult.parsed?.alert_type === "add_memory_to_vm") {
      return { matched: false };
    }
    
    // If we had a policy match but needed LLM for field extraction, merge the results
    if (policyResult.matched && policyResult.policy) {
      // Merge policy extraction_rules with LLM-extracted fields
      const merged = {
        ...policyResult.policy.extraction_rules,
        ...llmResult.parsed,
        // Preserve policy's parse_method or use LLM's
        parse_method: "llm" // Since we used LLM for extraction
      };
      return {
        parsed: validateParsedAlert(merged),
        policy: policyResult.policy,
        matched: true,
        modelUsed: llmResult.modelUsed
      };
    }
    
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

/** Get a policy by alert_type (e.g. for fallback when channel restriction fails) */
export function getPolicyByAlertType(alertType) {
  const policies = loadPolicies();
  return policies.find((p) => p.alert_type === alertType) || null;
}

