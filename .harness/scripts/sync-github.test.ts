import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIssueBody } from "./sync-github";
import { PHASES_DIR } from "./lib/paths";
import type { Feature, FeatureList } from "./lib/types";

// findPhaseDir("p27") 需要真实存在的 phases/phase-p27-*/ 目录（模板仓的 phases/
// 默认为空，不像来源仓那样带着 p27 真实阶段）——建一次性 fixture，测完即清。
const PHASE_DIR = join(PHASES_DIR, "phase-p27-fixture");
beforeEach(() => mkdirSync(PHASE_DIR, { recursive: true }));
afterEach(() => rmSync(PHASE_DIR, { recursive: true, force: true }));

describe("buildIssueBody", () => {
  it("links p27 feature issues to parent issue 662", () => {
    const feature: Feature = {
      id: "F01",
      priority: 1,
      area: "ai-store-data",
      title: "Team tenancy",
      user_visible_behavior: "Team resources are isolated.",
      status: "not_started",
      sprint: "01",
      owner: null,
      capability: "CAP-DATA",
      depends_on: [],
      wave: 0,
      verification: ["true"],
      evidence: "",
      notes: "Parent issue projection test.",
    };
    const featureList: FeatureList = { phase: "p27", features: [feature] };

    const body = buildIssueBody(
      feature,
      "p27",
      "01",
      "acme/acme-dev-template",
      featureList,
      662,
    );

    expect(body).toContain("## Parent Tracking Issue");
    expect(body).toContain("Parent: #662");
    expect(body).toContain(
      "https://github.com/acme/acme-dev-template/issues/662",
    );
  });
});
