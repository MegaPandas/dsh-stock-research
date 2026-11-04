export function createFollowupPolicyAdapter(
  { LlmAdapter, ToolCallId },
  probeQueries,
  background = false,
) {
  const report = {
    summary: "合成夹具仅验证公开角色报告和续聊机制，不作现实市场判断。",
    content: {
      currentState: ["本报告是定性合成夹具，不代表比亚迪真实经营状态。"],
      analysisModel: {
        drivers: ["合成驱动变量"],
        mechanism: "合成内容用于检查报告保存和原会话修订。",
        assumptions: ["不从夹具内容推断现实证券表现。"],
        alternativeExplanations: ["现实业务变化需要独立研究。"],
      },
      outlook: {
        horizon: "合成观察期",
        baseCase: {
          conditions: ["夹具条件保持。"],
          expectation: "验证既有章节可以随续聊保留。",
        },
        alternativeCases: [
          {
            conditions: ["合成条件变化。"],
            expectation: "另行评估夹具条件，不形成投资判断。",
          },
        ],
        watchPoints: ["报告保存与审批审计结果。"],
      },
      risks: [
        {
          factor: "合成输入的适用范围",
          impact: "夹具内容不能作为实际投资依据。",
          trigger: "将验收夹具误认为现实研究。",
        },
      ],
      handoff: {
        implications: ["仅检验公开搜索与报告生命周期。"],
        openQuestions: ["真实业务结论不在夹具覆盖范围内。"],
        limitations: ["全部业务叙述均为定性合成夹具。"],
      },
    },
  };
  const stageHandoff = {
    keyPoints: ["合成夹具仅供生命周期与审批验收。"],
    disagreements: [],
    risks: [],
    openQuestions: ["不将该夹具作为现实市场判断。"],
  };
  async function* fixtureToolCall(name, value, callId) {
    const id = ToolCallId(callId);
    const args = JSON.stringify(value);
    yield { type: "block-start", index: 0, blockType: "tool-call" };
    yield {
      type: "tool-call-delta",
      index: 0,
      id,
      name,
      argumentsDelta: args,
    };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id, name, arguments: args },
    };
    yield { type: "finish", reason: { kind: "tool-calls" } };
  }
  async function* fixtureText(text) {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  let parentStarted = false;
  let childSessionId;
  const handledSettled = new Set();
  const steps = new Map();
  async function* respond(request) {
    if (String(request.sessionId) === "real-quick-role-probe") {
      if (background) {
        // Runtime snapshots can follow the turn's actual input in the request.
        const input = request.messages
          .filter(
            (message) =>
              message.role === "user" && message.source?.form !== "snapshot",
          )
          .at(-1);
        if (
          input?.source?.kind !== "subagent-settled" ||
          childSessionId === undefined ||
          input.source.senderSessionId !== childSessionId ||
          typeof input.id !== "string" ||
          handledSettled.has(input.id)
        )
          throw new Error("Unexpected input to the background parent fixture.");
        handledSettled.add(input.id);
        yield* fixtureText(
          "Fixture parent received its child's settled notice.",
        );
        return;
      }
      if (!parentStarted) {
        parentStarted = true;
        yield* fixtureToolCall(
          "stock_acceptance_followup",
          {},
          "fixture-parent-acceptance",
        );
      } else yield* fixtureText("Fixture parent completed.");
      return;
    }
    if (background) {
      const sessionId = String(request.sessionId);
      if (childSessionId === undefined) childSessionId = sessionId;
      else if (sessionId !== childSessionId)
        throw new Error("Unexpected child session in the background fixture.");
    }
    const history = JSON.stringify(request.messages);
    const round = history.includes("followup-round-3")
      ? 3
      : history.includes("followup-round-2")
        ? 2
        : 1;
    const marker = `followup-round-${round}`;
    const updates =
      round === 1
        ? { summary: report.summary, ...report.content }
        : {
            summary: `合成夹具摘要修订：${marker}。`,
            handoff: {
              ...report.content.handoff,
              limitations: [
                ...report.content.handoff.limitations,
                `合成夹具交接修订：${marker}。`,
              ],
            },
          };
    const actions = [
      ...(round === 1
        ? [
            {
              name: "stock_search_public",
              value: { query: probeQueries.free },
            },
            {
              name: "stock_search_public",
              value: { query: probeQueries.firstRejected },
            },
          ]
        : [
            {
              name: "stock_search_public",
              value: {
                query: round === 2 ? probeQueries.paused : probeQueries.resumed,
              },
            },
          ]),
      { name: "stock_write_report", value: updates },
      { name: "stock_write_handoff", value: stageHandoff },
      { name: "stock_submit", value: {} },
    ];
    const step = steps.get(round) ?? 0;
    steps.set(round, step + 1);
    const action = actions[step];
    if (action === undefined)
      throw new Error(`Unexpected policy fixture round ${round} step ${step}`);
    yield* fixtureToolCall(
      action.name,
      action.value,
      `fixture-round-${round}-step-${step}`,
    );
  }
  class PolicyAdapter extends LlmAdapter {
    stream(request) {
      return respond(request);
    }
  }
  return new PolicyAdapter();
}
