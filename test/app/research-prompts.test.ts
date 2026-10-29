import { describe, expect, it } from "vitest";
import { ASK_PROMPT } from "../../src/app/ask-prompt.js";
import { COORDINATOR_PROMPT } from "../../src/app/coordinator-prompt.js";
import {
  PUBLIC_ANALYST_PROMPT,
  PUBLIC_RESEARCH_BRIEF,
} from "../../src/app/public-research.js";
import { SHARED_BRIEFS } from "../../src/app/research-plan.js";
import { ROLE_PROMPTS } from "../../src/app/research-prompts.js";
import { REVIEW_PROMPT } from "../../src/app/review-prompt.js";

describe("research role instructions", () => {
  it.each(
    Object.entries({
      ...ROLE_PROMPTS,
      public: PUBLIC_ANALYST_PROMPT,
      ask: ASK_PROMPT,
      review: REVIEW_PROMPT,
      coordinator: COORDINATOR_PROMPT,
    }),
  )("applies the requested writing rule to %s", (_role, prompt) => {
    expect(prompt).toContain(
      "Delete defensive wording that only anticipates objections and adds no information about the subject.",
    );
    expect(prompt).toContain(
      "Include only specific risks, assumptions, open questions and data limits that affect the judgment",
    );
    expect(prompt).toContain("in Chinese");
    expect(prompt).not.toMatch(/\p{Script=Han}/u);
  });

  it("assigns the manager a target-price estimate under the supplied decision policy", () => {
    for (const prompt of [
      ROLE_PROMPTS.manager,
      SHARED_BRIEFS["manager.decision"],
    ]) {
      expect(prompt).toContain("context.decisionPolicy");
      expect(prompt).toMatch(/The code determines .*horizon and rating/);
    }
  });

  it("separates investor risk actions from company operating decisions", () => {
    expect(ROLE_PROMPTS.discussion).toContain(
      "investor exposure or position constraints",
    );
    expect(ROLE_PROMPTS.discussion).toContain(
      "Treat company operating actions such as capex, inventory management and credit policy as observations",
    );
  });

  it("keeps public research focused on products and competition", () => {
    expect(PUBLIC_ANALYST_PROMPT).toContain("reporting schedules");
    expect(PUBLIC_ANALYST_PROMPT).toContain(
      "do not search for or reconstruct them here",
    );
    expect(PUBLIC_RESEARCH_BRIEF).toContain(
      "Pass financial questions affecting the judgment to the fundamentals analyst",
    );
    expect(PUBLIC_RESEARCH_BRIEF).toContain(
      "Compare competitors in the same segment, price band, region and period",
    );
  });
});
