// @ts-check

const COMMENT_MARKER = "<!-- e2e-risk-assessment-bot -->";
const MAX_DIFF_SIZE = 60000;
const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
const RISK_EMOJI = { low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" };

/**
 * @param {string} pattern - glob pattern like "frontend/**"
 * @param {string} filePath - file path like "frontend/pkg/main.go"
 * @returns {boolean}
 */
function matchGlob(pattern, filePath) {
  const parts = pattern.split("**");
  if (parts.length === 2) {
    return filePath.startsWith(parts[0]);
  }
  return filePath.startsWith(pattern.replace(/\*+$/, ""));
}

/**
 * Phase 1: Deterministic path-to-area mapping
 * @param {string[]} changedFiles
 * @param {object} mapping
 * @returns {{ areas: Map<string, {risk: string, reasons: string[]}>, overallRisk: string }}
 */
function mapFilesToAreas(changedFiles, mapping) {
  /** @type {Map<string, {risk: string, reasons: string[]}>} */
  const areas = new Map();
  let overallRisk = "low";

  for (const file of changedFiles) {
    for (const rule of mapping.mappings) {
      const matched = rule.paths.some((pattern) => matchGlob(pattern, file));
      if (!matched) continue;

      for (const area of rule.areas) {
        const existing = areas.get(area);
        if (existing) {
          if (RISK_ORDER[rule.risk] > RISK_ORDER[existing.risk]) {
            existing.risk = rule.risk;
          }
          if (!existing.reasons.includes(rule.description)) {
            existing.reasons.push(rule.description);
          }
        } else {
          areas.set(area, {
            risk: rule.risk,
            reasons: [rule.description],
          });
        }
      }

      if (RISK_ORDER[rule.risk] > RISK_ORDER[overallRisk]) {
        overallRisk = rule.risk;
      }
    }
  }

  return { areas, overallRisk };
}

/**
 * Phase 2: AI-powered diff analysis via GitHub Models API
 * @param {object} params
 * @param {object} params.github
 * @param {string} params.diff
 * @param {Map<string, {risk: string, reasons: string[]}>} params.areas
 * @param {object} params.areaDescriptions
 * @returns {Promise<string|null>}
 */
async function analyzeWithAI({ github, diff, areas, areaDescriptions }) {
  const areasSummary = Array.from(areas.entries())
    .map(([name, info]) => `- ${name} (${info.risk}): ${info.reasons.join(", ")}`)
    .join("\n");

  const prompt = `You are an E2E test risk analyst for the ARO-HCP project (Azure Red Hat OpenShift with Hosted Control Planes).

The following PR diff has been deterministically mapped to these E2E test areas:
${areasSummary}

Area definitions:
${Object.entries(areaDescriptions)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

Analyze this diff for subtle risks that the path-based mapping might miss:
1. API contract changes (struct field additions/removals, validation changes)
2. Configuration drift (default value changes, environment variable changes)
3. Behavioral changes (error handling modifications, retry logic, timeout changes)
4. Cross-component impacts (changes in shared internal packages)

Be concise. Focus only on risks that could cause E2E test failures. If the changes look safe from an E2E perspective, say so briefly.

Diff (may be truncated):
\`\`\`
${diff.slice(0, MAX_DIFF_SIZE)}
\`\`\``;

  try {
    const response = await github.request(
      "POST /models/chat/completions",
      {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 500,
      }
    );
    return response.data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    return null;
  }
}

/**
 * Build the recommended Prow test commands based on risk
 * @param {string} overallRisk
 * @param {Map<string, {risk: string, reasons: string[]}>} areas
 * @returns {string[]}
 */
function recommendTests(overallRisk, areas) {
  const commands = [];

  if (RISK_ORDER[overallRisk] >= RISK_ORDER["medium"]) {
    commands.push("/test e2e-parallel");
  }

  if (RISK_ORDER[overallRisk] >= RISK_ORDER["high"]) {
    commands.push("/test integration-e2e-parallel");
  }

  if (
    RISK_ORDER[overallRisk] >= RISK_ORDER["critical"] ||
    areas.has("all-e2e")
  ) {
    commands.push("/test stage-e2e-parallel");
  }

  return commands;
}

/**
 * Build the PR comment body
 * @param {object} params
 * @param {string} params.overallRisk
 * @param {Map<string, {risk: string, reasons: string[]}>} params.areas
 * @param {object} params.areaDescriptions
 * @param {string[]} params.recommendedTests
 * @param {string|null} params.aiAnalysis
 * @returns {string}
 */
function buildComment({
  overallRisk,
  areas,
  areaDescriptions,
  recommendedTests,
  aiAnalysis,
}) {
  const emoji = RISK_EMOJI[overallRisk];
  const riskLabel = overallRisk.charAt(0).toUpperCase() + overallRisk.slice(1);

  let body = `${COMMENT_MARKER}\n## E2E Risk Assessment\n\n`;
  body += `**Risk Level: ${emoji} ${riskLabel}**\n\n`;

  if (areas.size === 0) {
    body += `No E2E-impacting paths detected in this PR. The changes appear isolated from E2E test coverage.\n`;
  } else {
    body += `### Affected Areas\n\n`;
    body += `| Area | Risk | Reason |\n`;
    body += `|------|------|--------|\n`;

    const sorted = Array.from(areas.entries()).sort(
      (a, b) => RISK_ORDER[b[1].risk] - RISK_ORDER[a[1].risk]
    );

    for (const [area, info] of sorted) {
      const areaLabel = areaDescriptions[area] || area;
      const riskBadge = `${RISK_EMOJI[info.risk]} ${info.risk}`;
      body += `| ${area} | ${riskBadge} | ${info.reasons.join("; ")} |\n`;
    }
  }

  if (recommendedTests.length > 0) {
    body += `\n### Recommended Tests\n\n`;
    body += `Before merging, consider running these Prow jobs:\n\n`;
    body += "```\n";
    body += recommendedTests.join("\n");
    body += "\n```\n";
  }

  if (aiAnalysis) {
    body += `\n### AI Analysis\n\n`;
    body += `> ${aiAnalysis.replace(/\n/g, "\n> ")}\n`;
  } else if (areas.size > 0) {
    body += `\n*AI analysis unavailable — showing deterministic assessment only.*\n`;
  }

  body += `\n---\n`;
  body += `*Generated by [Copilot E2E Risk Assessment](.github/e2e-risk/path-mapping.json) — update path mappings to improve accuracy*\n`;

  return body;
}

/**
 * @param {object} params
 * @param {object} params.github
 * @param {object} params.context
 * @param {object} params.core
 */
module.exports = async ({ github, context, core }) => {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const prNumber = context.payload.pull_request.number;

  const fs = require("fs");
  const path = require("path");
  const mappingPath = path.join(
    process.env.GITHUB_WORKSPACE || ".",
    ".github",
    "e2e-risk",
    "path-mapping.json"
  );
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));

  core.info(`Analyzing PR #${prNumber} for E2E risk...`);

  const filesResponse = await github.paginate(
    github.rest.pulls.listFiles,
    { owner, repo, pull_number: prNumber, per_page: 100 }
  );
  const changedFiles = filesResponse.map((f) => f.filename);
  core.info(`Found ${changedFiles.length} changed files`);

  const { areas, overallRisk } = mapFilesToAreas(changedFiles, mapping);
  core.info(
    `Deterministic mapping: ${areas.size} areas affected, overall risk: ${overallRisk}`
  );

  let aiAnalysis = null;
  if (areas.size > 0) {
    const riskFileOrder = filesResponse
      .filter((f) => f.patch)
      .sort((a, b) => {
        const riskA = mapping.mappings.reduce((max, rule) => {
          if (rule.paths.some((p) => matchGlob(p, a.filename))) {
            return Math.max(max, RISK_ORDER[rule.risk] || 0);
          }
          return max;
        }, 0);
        const riskB = mapping.mappings.reduce((max, rule) => {
          if (rule.paths.some((p) => matchGlob(p, b.filename))) {
            return Math.max(max, RISK_ORDER[rule.risk] || 0);
          }
          return max;
        }, 0);
        return riskB - riskA;
      });

    let diff = "";
    for (const file of riskFileOrder) {
      const chunk = `--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}\n`;
      if (diff.length + chunk.length > MAX_DIFF_SIZE) break;
      diff += chunk;
    }

    if (diff.length < MAX_DIFF_SIZE && riskFileOrder.length < filesResponse.length) {
      core.info(
        `Diff built from ${riskFileOrder.length} files with patches ` +
        `(${filesResponse.length - riskFileOrder.length} files had no patch)`
      );
    }

    aiAnalysis = await analyzeWithAI({
      github,
      diff,
      areas,
      areaDescriptions: mapping.areaDescriptions,
    });

    if (aiAnalysis) {
      core.info("AI analysis completed");
    } else {
      core.warning("AI analysis unavailable, falling back to deterministic only");
    }
  }

  const recommendedTests = recommendTests(overallRisk, areas);

  const commentBody = buildComment({
    overallRisk,
    areas,
    areaDescriptions: mapping.areaDescriptions,
    recommendedTests,
    aiAnalysis,
  });

  const existingComments = await github.paginate(
    github.rest.issues.listComments,
    { owner, repo, issue_number: prNumber, per_page: 100 }
  );
  const botComment = existingComments.find(
    (c) => c.body && c.body.includes(COMMENT_MARKER)
  );

  if (botComment) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: botComment.id,
      body: commentBody,
    });
    core.info(`Updated existing comment #${botComment.id}`);
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: commentBody,
    });
    core.info("Created new assessment comment");
  }

  core.setOutput("risk_level", overallRisk);
  core.setOutput("affected_areas", Array.from(areas.keys()).join(","));
};
