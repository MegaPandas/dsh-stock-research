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
      "凡仅用于规避质疑、对描述现状无实际作用的保守性叙述和防御性写作，一律删除。",
    );
    expect(prompt).toContain("输出报告同样遵守这一要求。");
  });

  it("assigns the manager a target-price estimate under the supplied decision policy", () => {
    for (const prompt of [
      ROLE_PROMPTS.manager,
      SHARED_BRIEFS["manager.decision"],
    ]) {
      expect(prompt).toContain("context.decisionPolicy");
      expect(prompt).toContain("评级由代码确定");
      expect(prompt).not.toContain("投资决策给出评级");
      expect(prompt).not.toContain("评级、基准价和目标价按各自依据填写");
    }
  });

  it("separates investor risk actions from company operating decisions", () => {
    expect(ROLE_PROMPTS.discussion).toContain("投资者的暴露或仓位约束");
    expect(ROLE_PROMPTS.discussion).toContain("公司经营动作作为观察事项");
  });

  it("keeps public research focused on products and competition", () => {
    for (const prompt of [PUBLIC_RESEARCH_BRIEF, PUBLIC_ANALYST_PROMPT]) {
      expect(prompt).toContain("财报披露时间");
      expect(prompt).toContain("本方向不检索或重建这些数据");
    }
    expect(PUBLIC_RESEARCH_BRIEF).toContain(
      "比较同细分市场、价格带、地区及期间的竞品",
    );
  });
});
