import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "config", "jee-main.json");
const INDEX_PATH = path.join(ROOT, "data", "papers", "index.json");
const PAPERS_DIR = path.join(ROOT, "data", "papers");

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is not configured.");
}

fs.mkdirSync(PAPERS_DIR, { recursive: true });

function isoNow() {
  return new Date().toISOString();
}

function todayIST() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = (name) => parts.find((p) => p.type === name)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\\([^)]*\\)/g, "")
    .replace(/[^\\p{L}\\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shingles(text, n = 3) {
  const words = normalize(text).split(" ").filter(Boolean);
  const out = new Set();
  for (let i = 0; i <= words.length - n; i++) {
    out.add(words.slice(i, i + n).join(" "));
  }
  return out;
}

function similarity(a, b) {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return common / Math.max(1, Math.min(A.size, B.size));
}

function extractJsonText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

async function callOpenAI({ instructions, input, schema, name }) {
  const body = {
    model: MODEL,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: instructions }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: input }]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name,
        strict: true,
        schema
      }
    }
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI API ${response.status}: ${raw.slice(0, 2000)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI returned invalid JSON.");
  }

  const text = extractJsonText(parsed);
  if (!text) throw new Error("OpenAI returned no structured output.");

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Structured output could not be parsed as JSON.");
  }
}

const questionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "subject", "section", "type", "chapter", "difficulty",
    "question", "options", "answer", "solution"
  ],
  properties: {
    id: { type: "string" },
    subject: { type: "string", enum: ["Physics", "Chemistry", "Mathematics"] },
    section: { type: "string", enum: ["A", "B"] },
    type: { type: "string", enum: ["mcq", "numerical"] },
    chapter: { type: "string" },
    difficulty: { type: "string", enum: ["Easy", "Medium", "Hard", "Advanced"] },
    question: { type: "string" },
    options: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 4
    },
    answer: { type: "string" },
    solution: { type: "string" }
  }
};

const paperSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "subtitle", "instructions", "questions"],
  properties: {
    title: { type: "string" },
    subtitle: { type: "string" },
    instructions: {
      type: "array",
      items: { type: "string" }
    },
    questions: {
      type: "array",
      minItems: 75,
      maxItems: 75,
      items: questionSchema
    }
  }
};

const verifierSchema = {
  type: "object",
  additionalProperties: false,
  required: ["valid", "invalidQuestionIds", "issues"],
  properties: {
    valid: { type: "boolean" },
    invalidQuestionIds: {
      type: "array",
      items: { type: "string" }
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["questionId", "reason"],
        properties: {
          questionId: { type: "string" },
          reason: { type: "string" }
        }
      }
    }
  }
};

const repairSchema = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      items: questionSchema
    }
  }
};

const recentQuestionStems = [];
for (const entry of index.papers.slice(0, 3)) {
  const file = path.join(ROOT, entry.path);
  if (!fs.existsSync(file)) continue;
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const q of old.questions || []) {
      recentQuestionStems.push({
        id: q.id,
        subject: q.subject,
        question: q.question
      });
    }
  } catch {
    // Ignore a broken historical file here; validation of the current run still applies.
  }
}

const blueprint = Object.entries(config.subjects)
  .map(([subject, spec]) =>
    `${subject}: exactly ${spec.questions} questions = ${spec.mcq} Section A single-correct MCQs + ${spec.numerical} Section B numerical-answer questions.`
  )
  .join("\n");

const generationInstructions = `You are a senior JEE test setter and rigorous academic editor.

Create a fresh JEE Main Paper 1 practice paper for 2026 in Hindi medium. This is a serious exam-preparation product, not casual trivia.

Follow this blueprint exactly:
${blueprint}

Global requirements:
- Use only JEE Main 2026-appropriate Paper 1 topics and level.
- Do not invent out-of-syllabus advanced topics.
- Make the paper original; do not reproduce known coaching questions verbatim.
- Mix conceptual, computational and multi-step questions.
- Maintain a realistic balance of Easy, Medium and Hard/Advanced questions.
- Ensure options are plausible and exactly one MCQ option is correct.
- Numerical answers must be deterministic and gradeable as a number.
- Every question must have a complete, independently checkable solution.
- Use Hindi (Devanagari) for all user-facing natural-language content: title, subtitle, instructions, chapter names, questions, options and solutions.
- Keep the schema-required subject labels exactly as Physics, Chemistry and Mathematics.
- Standard scientific/technical terms may include the familiar English term in parentheses when that improves clarity, but the primary wording must remain Hindi.
- Use LaTeX notation for mathematics/physics/chemistry where useful.
- Avoid ambiguous wording and missing data.
- Units, signs, constants and domains must be explicit whenever needed.
- Question IDs must be unique and stable, e.g. PHY-001 ... MAT-025.
- For MCQ: answer must be exactly A, B, C or D.
- For numerical: answer must be a numeric string suitable for numeric comparison.
- Do not include answer hints in the question text.
- Do not rely on images that are not embedded in the text.
- Do not create duplicate or near-duplicate questions.

Reference pattern: the official NTA 2026 Paper 1 bulletin should be treated as authoritative for the current pattern.`;

const previous = recentQuestionStems
  .slice(0, 120)
  .map((q) => `[${q.subject}] ${q.id}: ${q.question}`)
  .join("\n");

const paper = await callOpenAI({
  name: "jee_daily_paper",
  schema: paperSchema,
  instructions: generationInstructions,
  input: `Generate today's paper for ${todayIST()}.

Previous-question context is provided ONLY to help avoid semantic duplication. Do not copy these questions.

--- Previous question stems ---
${previous || "(none yet)"}
--- End previous stems ---

Return exactly 75 questions.`
});

function localValidate(candidate) {
  const errors = [];
  const qs = candidate.questions || [];

  if (qs.length !== 75) {
    errors.push(`Expected 75 questions, got ${qs.length}.`);
  }

  const counts = {
    Physics: { mcq: 0, numerical: 0 },
    Chemistry: { mcq: 0, numerical: 0 },
    Mathematics: { mcq: 0, numerical: 0 }
  };

  const ids = new Set();

  for (const q of qs) {
    if (ids.has(q.id)) errors.push(`Duplicate question ID: ${q.id}`);
    ids.add(q.id);

    if (!counts[q.subject]) {
      errors.push(`Invalid subject: ${q.subject}`);
      continue;
    }

    counts[q.subject][q.type]++;

    if (q.type === "mcq") {
      if (q.options.length !== 4) errors.push(`${q.id}: MCQ must have 4 options.`);
      if (!["A", "B", "C", "D"].includes(q.answer)) {
        errors.push(`${q.id}: MCQ answer must be A/B/C/D.`);
      }
      if (q.section !== "A") errors.push(`${q.id}: MCQ must be Section A.`);
    }

    if (q.type === "numerical") {
      if (q.options.length !== 0) errors.push(`${q.id}: numerical question must have no options.`);
      if (q.section !== "B") errors.push(`${q.id}: numerical must be Section B.`);
      if (!Number.isFinite(Number(q.answer))) {
        errors.push(`${q.id}: numerical answer is not numeric.`);
      }
    }

    if (!q.question.trim() || !q.solution.trim()) {
      errors.push(`${q.id}: missing question or solution.`);
    }

    for (const old of recentQuestionStems) {
      if (old.subject !== q.subject) continue;
      const score = similarity(q.question, old.question);
      if (score >= 0.72) {
        errors.push(`${q.id}: too similar to previous ${old.id} (similarity ${score.toFixed(2)}).`);
        break;
      }
    }
  }

  for (const subject of Object.keys(counts)) {
    if (counts[subject].mcq !== 20) {
      errors.push(`${subject}: expected 20 MCQs, got ${counts[subject].mcq}.`);
    }
    if (counts[subject].numerical !== 5) {
      errors.push(`${subject}: expected 5 numerical questions, got ${counts[subject].numerical}.`);
    }
  }

  for (let i = 0; i < qs.length; i++) {
    for (let j = i + 1; j < qs.length; j++) {
      if (qs[i].subject !== qs[j].subject) continue;
      const score = similarity(qs[i].question, qs[j].question);
      if (score >= 0.82) {
        errors.push(`Internal duplicate-like questions: ${qs[i].id} and ${qs[j].id}.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

let local = localValidate(paper);
if (!local.ok) {
  throw new Error("Local validation failed:\n" + local.errors.join("\n"));
}

const verifierInput = paper.questions.map((q) =>
  JSON.stringify({
    id: q.id,
    subject: q.subject,
    type: q.type,
    chapter: q.chapter,
    question: q.question,
    options: q.options,
    answer: q.answer,
    solution: q.solution
  })
).join("\n");

const verification = await callOpenAI({
  name: "jee_paper_verification",
  schema: verifierSchema,
  instructions: `You are the final independent quality-control reviewer for a high-stakes JEE practice paper.

For every question:
- solve it independently;
- check the keyed answer;
- check all MCQ distractors;
- check numerical arithmetic;
- check units and assumptions;
- check whether the wording is unambiguous;
- check that the solution actually reaches the keyed answer;
- reject hallucinated facts or impossible premises;
- reject out-of-syllabus content for JEE Main 2026.

Return valid=true only when the complete paper is publishable. Be strict.`,
  input: verifierInput
});

let finalPaper = paper;

if (!verification.valid) {
  const invalidIds = new Set(verification.invalidQuestionIds || []);
  const repairTargets = paper.questions.filter((q) => invalidIds.has(q.id));
  const issueText = (verification.issues || [])
    .map((x) => `${x.questionId}: ${x.reason}`)
    .join("\n");

  if (!repairTargets.length) {
    throw new Error("Independent verification failed without actionable question IDs:\n" + issueText);
  }

  const repaired = await callOpenAI({
    name: "jee_question_repair",
    schema: repairSchema,
    instructions: `Repair only the supplied invalid JEE questions.

Keep each question ID unchanged.
Keep subject, section and type unchanged.
Return corrected, independently solvable questions.
Do not change valid questions.
Do not add or remove questions.`,
    input: `Fix these questions based on the QC findings:

${issueText}

Questions to repair:
${repairTargets.map((q) => JSON.stringify(q)).join("\n")}`
  });

  const byId = new Map((repaired.questions || []).map((q) => [q.id, q]));
  finalPaper = {
    ...paper,
    questions: paper.questions.map((q) => byId.get(q.id) || q)
  };

  local = localValidate(finalPaper);
  if (!local.ok) {
    throw new Error("Post-repair local validation failed:\n" + local.errors.join("\n"));
  }

  const secondCheck = await callOpenAI({
    name: "jee_paper_verification_final",
    schema: verifierSchema,
    instructions: `Re-check the supplied repaired questions with the same rigor as a JEE examination quality-control editor. Return valid=true only if every supplied question is correct, unambiguous and publishable.`,
    input: repaired.questions.map((q) => JSON.stringify(q)).join("\n")
  });

  if (!secondCheck.valid) {
    throw new Error("Final independent verification still failed:\n" +
      (secondCheck.issues || []).map((x) => `${x.questionId}: ${x.reason}`).join("\n"));
  }
}

const date = todayIST();
const fileName = `${date}.json`;
const filePath = path.join(PAPERS_DIR, fileName);

const normalizedQuestions = finalPaper.questions.map((q, index) => ({
  ...q,
  number: index + 1,
  marks: 4,
  negativeMarks: -1
}));

const output = {
  id: `jee-main-${date}`,
  date,
  generatedAt: isoNow(),
  exam: config.exam,
  durationMinutes: config.durationMinutes,
  marking: config.marking,
  title: finalPaper.title || `दैनिक JEE मुख्य परीक्षा अभ्यास पत्र — ${date}`,
  subtitle: finalPaper.subtitle || "JEE Main Paper 1 शैली का हिंदी अभ्यास पत्र",
  instructions: finalPaper.instructions || [],
  questions: normalizedQuestions,
  sourcePolicy: "Generated against the repository's configured 2026 JEE Main Paper 1 pattern. Verify against the latest NTA bulletin before using as an official-format mock."
};

fs.writeFileSync(filePath, JSON.stringify(output, null, 2) + "\n", "utf8");

const entry = {
  id: output.id,
  date: output.date,
  title: output.title,
  subtitle: output.subtitle,
  path: `data/papers/${fileName}`,
  generatedAt: output.generatedAt,
  questions: output.questions.length
};

const nextIndex = {
  generatedAt: output.generatedAt,
  papers: [
    entry,
    ...(index.papers || []).filter((p) => p.id !== entry.id)
  ]
};

fs.writeFileSync(INDEX_PATH, JSON.stringify(nextIndex, null, 2) + "\n", "utf8");

console.log(`Generated and validated ${output.id} with ${output.questions.length} questions.`);
