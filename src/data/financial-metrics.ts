import type {
  CollectionColumn,
  CollectionPacket,
  CollectionRow,
} from "../contracts/collection.js";
import type { DataGap, ResearchScope } from "../contracts/data.js";

const yearBefore = (date: string) =>
  `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
const nextDay = (date: string) =>
  new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const days = (start: string, end: string) =>
  (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
type Input = { packet: CollectionPacket; row: CollectionRow };

/** Pure snapshot calculation: periods and source units are retained, never fetched. */
export function deriveFinancialMetrics(
  scope: ResearchScope,
  packets: readonly CollectionPacket[],
): CollectionPacket | undefined {
  const financial = packets.filter(
    (p) => p.id.startsWith("financial.") && p.id !== "financial.metrics",
  );
  if (!financial.some((p) => p.envelope.data.rows.length)) return undefined;
  const inputs = financial.flatMap((packet) =>
    packet.envelope.data.rows.map((row) => ({ packet, row })),
  );
  const columns: Record<string, CollectionColumn> = {};
  const gaps: DataGap[] = financial.flatMap((p) =>
    p.envelope.gaps.map((g) => ({
      ...g,
      field: "/data",
      detail: `${p.id} ${g.field}: ${g.detail}`,
    })),
  );
  const rows: CollectionRow[] = [];
  const rowDependencies = new Map<CollectionRow, Input[]>();
  const attributes: Record<string, string> = {};
  const used = new Set<CollectionPacket>();
  const dates = [
    ...new Set(
      inputs.map((i) => `${i.row.periodStart ?? i.row.date}/${i.row.date}`),
    ),
  ].sort();
  for (const key of dates) {
    const [start, date] = key.split("/") as [string, string];
    const same = inputs.filter(
      (i) => i.row.date === date && (i.row.periodStart ?? date) === start,
    );
    const values: Record<string, number | null> = {};
    const dependencies: Input[] = [];
    const put = (
      name: string,
      label: string,
      unit: string,
      value: number | null,
      reason: string,
    ) => {
      columns[name] = { label, unit };
      values[name] = value;
      if (value === null)
        gaps.push({
          code: "missing",
          field: `/data/rows/${rows.length}/values/${name}`,
          detail: reason,
        });
      return value;
    };
    const read = (input: Input | undefined, field: string): number | null => {
      if (!input) return null;
      used.add(input.packet);
      dependencies.push(input);
      return input.row.values[field] ?? null;
    };
    const series: Record<
      string,
      { input: Input; field: string; unit: string }
    > = {};
    const select = (name: string, id: string, fields: string[]) => {
      const input = same.find((i) => i.packet.id === id);
      if (!input) return;
      const field =
        fields.find(
          (f) =>
            input.row.values[f] !== undefined && input.row.values[f] !== null,
        ) ?? fields[0]!;
      const column = input.packet.envelope.data.columns[field];
      if (column) series[name] = { input, field, unit: column.unit };
    };
    select("REVENUE", "financial.income", [
      "TOTAL_OPERATE_INCOME",
      "OPERATE_INCOME",
    ]);
    select("NET_INCOME", "financial.income", ["PARENT_NETPROFIT"]);
    select("DEDUCTED_NET_INCOME", "financial.income", [
      "DEDUCT_PARENT_NETPROFIT",
    ]);
    select("COST", "financial.income", ["OPERATE_COST"]);
    select("OPERATING_PROFIT", "financial.income", ["OPERATE_PROFIT"]);
    if (!same.some((i) => i.packet.id === "financial.income")) {
      select("REVENUE", "financial.indicators", ["TOTALOPERATEREVE"]);
      select("NET_INCOME", "financial.indicators", ["PARENTNETPROFIT"]);
      select("DEDUCTED_NET_INCOME", "financial.indicators", ["KCFJCXSYJLR"]);
    }
    select("REVENUE", "financial.revenue", ["revenue"]);
    select("NET_INCOME", "financial.netIncome", ["netIncome"]);
    select("OCF", "financial.cashflow", ["NETCASH_OPERATE"]);
    select("CAPEX", "financial.cashflow", ["CONSTRUCT_LONG_ASSET"]);
    const amounts: Record<string, number | null> = {};
    for (const [name, s] of Object.entries(series)) {
      const sourceRows = s.input.packet.envelope.data.rows;
      const find = (from: string, to: string) => {
        const row = sourceRows.find(
          (r) => r.date === to && r.periodStart === from,
        );
        return row ? { packet: s.input.packet, row } : undefined;
      };
      const current = read(s.input, s.field);
      const prior = read(find(yearBefore(start), yearBefore(date)), s.field);
      put(
        `${name}_YTD`,
        `${name} 原报告期间数值（期间见本行periodStart/date）`,
        s.unit,
        current,
        `Missing ${s.field} for ${start}/${date}.`,
      );
      put(
        `${name}_YOY`,
        `${name} 原报告同口径同比=(本期-上年同期)/abs(上年同期)×100`,
        "percent",
        current !== null && prior !== null && prior !== 0
          ? ((current - prior) / Math.abs(prior)) * 100
          : null,
        `Missing same-period prior-year ${s.field}, current value, or prior value is zero.`,
      );
      const duration = days(start, date);
      const preceding = sourceRows
        .filter(
          (r) =>
            r.periodStart === start &&
            r.date < date &&
            days(nextDay(r.date), date) >= 70 &&
            days(nextDay(r.date), date) <= 110,
        )
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const prev = read(
        preceding ? { packet: s.input.packet, row: preceding } : undefined,
        s.field,
      );
      const quarter =
        duration >= 70 && duration <= 110
          ? current
          : current !== null && prev !== null
            ? current - prev
            : null;
      amounts[`${name}_QUARTER`] = put(
        `${name}_QUARTER`,
        `${name} 单季度=累计-上一季度累计；首季取原值`,
        s.unit,
        quarter,
        `Missing matching preceding cumulative ${s.field} for a single quarter.`,
      );
      const priorEnd = new Date(Date.parse(start) - 86400000)
        .toISOString()
        .slice(0, 10);
      const annualRow = sourceRows.find(
        (r) =>
          r.date === priorEnd &&
          r.periodStart === yearBefore(start) &&
          days(r.periodStart, r.date) >= 330 &&
          days(r.periodStart, r.date) <= 380,
      );
      const annualValue = read(
        annualRow ? { packet: s.input.packet, row: annualRow } : undefined,
        s.field,
      );
      let ttm =
        duration >= 330 && duration <= 380
          ? current
          : current !== null && annualValue !== null && prior !== null
            ? current + annualValue - prior
            : null;
      if (ttm === null && duration >= 70 && duration <= 110) {
        const quarters = [s.input.row];
        while (quarters.length < 4) {
          const first = quarters[0]!;
          const precedingEnd = new Date(
            Date.parse(first.periodStart!) - 86400000,
          )
            .toISOString()
            .slice(0, 10);
          const previousQuarter = sourceRows.find(
            (r) =>
              r.date === precedingEnd &&
              r.periodStart !== undefined &&
              days(r.periodStart, r.date) >= 70 &&
              days(r.periodStart, r.date) <= 110,
          );
          if (!previousQuarter) break;
          quarters.unshift(previousQuarter);
        }
        if (
          quarters.length === 4 &&
          days(quarters[0]!.periodStart!, date) >= 330 &&
          days(quarters[0]!.periodStart!, date) <= 380
        ) {
          const amounts = quarters.map((row) =>
            read({ packet: s.input.packet, row }, s.field),
          );
          if (amounts.every((value) => value !== null))
            ttm = amounts.reduce<number>((sum, value) => sum + value!, 0);
        }
      }
      amounts[`${name}_TTM`] = put(
        `${name}_TTM`,
        `${name} TTM：全年取原值；累计用上年全年-上年同口径累计+本期累计；独立季度用连续四个无重叠季度合计`,
        s.unit,
        ttm,
        `Missing matching fiscal annual/prior-year cumulative ${s.field}, or four contiguous non-overlapping quarters.`,
      );
    }
    const compatible = (a: string, b: string) =>
      series[a] &&
      series[b] &&
      series[a].unit === series[b].unit &&
      series[a].input.packet.envelope.source.provider ===
        series[b].input.packet.envelope.source.provider;
    for (const basis of ["QUARTER", "TTM"]) {
      const combine = (
        name: string,
        a: string,
        b: string,
        label: string,
        ratio: boolean,
      ) => {
        if (!series[a] && !series[b]) return;
        const av = amounts[`${a}_${basis}`] ?? null,
          bv = amounts[`${b}_${basis}`] ?? null;
        const unit = ratio ? "ratio" : (series[a]?.unit ?? series[b]!.unit);
        put(
          `${name}_${basis}`,
          `${label} (${basis})`,
          unit,
          compatible(a, b) && av !== null && bv !== null && (!ratio || bv !== 0)
            ? ratio
              ? av / bv
              : av - bv
            : null,
          `Requires same-provider same-unit ${a} and ${b} for ${start}/${date}; denominator must be nonzero.`,
        );
      };
      combine(
        "FREE_CASH_FLOW",
        "OCF",
        "CAPEX",
        "自由现金流=经营现金流-购建长期资产现金",
        false,
      );
      combine(
        "CASH_CONVERSION",
        "OCF",
        "NET_INCOME",
        "现金含量=经营现金流/归母净利润",
        true,
      );
      combine(
        "NET_MARGIN",
        "NET_INCOME",
        "REVENUE",
        "归母净利率=归母净利润/收入",
        true,
      );
      combine(
        "OPERATING_MARGIN",
        "OPERATING_PROFIT",
        "REVENUE",
        "营业利润率=营业利润/收入",
        true,
      );
      const revenue = amounts[`REVENUE_${basis}`] ?? null,
        cost = amounts[`COST_${basis}`] ?? null;
      if (series.REVENUE)
        put(
          `GROSS_MARGIN_${basis}`,
          `毛利率=(收入-营业成本)/收入 (${basis})`,
          "ratio",
          compatible("REVENUE", "COST") &&
            revenue !== null &&
            revenue !== 0 &&
            cost !== null
            ? (revenue - cost) / revenue
            : null,
          "Missing same-provider same-unit revenue/cost, or revenue is zero.",
        );
    }
    const balance = inputs.find(
      (i) => i.packet.id === "financial.balance" && i.row.date === date,
    );
    if (balance && start === date) {
      const unit =
        balance.packet.envelope.data.columns.TOTAL_EQUITY?.unit ??
        scope.security.currency;
      const wc = (input: Input | undefined) => {
        const ar = read(input, "ACCOUNTS_RECE"),
          inv = read(input, "INVENTORY"),
          ap = read(input, "ACCOUNTS_PAYABLE");
        return ar !== null && inv !== null && ap !== null
          ? ar + inv - ap
          : null;
      };
      const current = wc(balance);
      put(
        "SIMPLIFIED_WORKING_CAPITAL",
        "简化营运资本=应收账款+存货-应付账款",
        unit,
        current,
        "Missing ACCOUNTS_RECE, INVENTORY or ACCOUNTS_PAYABLE.",
      );
      const previous = balance.packet.envelope.data.rows
        .filter((r) => r.date < date)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      const prior = wc(
        previous ? { packet: balance.packet, row: previous } : undefined,
      );
      put(
        "SIMPLIFIED_WORKING_CAPITAL_CHANGE",
        "简化营运资本较上一报告期变化=本期-上期",
        unit,
        current !== null && prior !== null ? current - prior : null,
        "Missing complete previous reporting-period working capital.",
      );
    }
    const indicator = inputs.find(
      (i) => i.packet.id === "financial.indicators" && i.row.date === date,
    );
    if (indicator && same.includes(indicator)) {
      const bps = read(indicator, "BPS");
      const bpsUnit =
        indicator.packet.envelope.data.columns.BPS?.unit ??
        `${scope.security.currency}/share`;
      put(
        "BPS",
        "来源每股净资产；BPS日期=本行date",
        bpsUnit,
        bps,
        "Missing BPS.",
      );
      const valuation = packets.find((p) => p.id === "valuation.history");
      const shareRow = valuation?.envelope.data.rows
        .filter((r) => r.asOf <= scope.cutoff)
        .at(-1);
      const sharesInput =
        valuation && shareRow
          ? { packet: valuation, row: shareRow }
          : undefined;
      if (shareRow) attributes.currentSharesDate = shareRow.date;
      const shares = read(sharesInput, "TOTAL_SHARES");
      put(
        "CURRENT_TOTAL_SHARES",
        "当前总股本；观察日期见attributes.currentSharesDate",
        "shares",
        shares,
        "Missing valuation.history TOTAL_SHARES.",
      );
      const equity =
        bps !== null &&
        shares !== null &&
        bpsUnit === `${scope.security.currency}/share` &&
        valuation?.envelope.data.columns.TOTAL_SHARES?.unit === "shares"
          ? bps * shares
          : null;
      put(
        "PARENT_EQUITY_COMPARISON",
        "归母权益推导对照=BPS(本行date)×当前总股本；股本日期见attributes.currentSharesDate，非原报权益",
        scope.security.currency,
        equity,
        "Missing compatible BPS/share units or current shares.",
      );
      const total =
        balance &&
        balance.packet.envelope.source.provider ===
          indicator.packet.envelope.source.provider &&
        balance.packet.envelope.data.columns.TOTAL_EQUITY?.unit ===
          scope.security.currency
          ? read(balance, "TOTAL_EQUITY")
          : null;
      put(
        "MINORITY_EQUITY_ESTIMATE",
        "少数权益估算=TOTAL_EQUITY-BPS×当前总股本；非原报值",
        scope.security.currency,
        total !== null && equity !== null ? total - equity : null,
        "Missing same-provider TOTAL_EQUITY or parent equity comparison.",
      );
      const ni = amounts.NET_INCOME_TTM ?? null;
      put(
        "ROE_TTM_END_EQUITY_COMPARISON",
        "TTM归母净利/期末BPS×当前股本权益对照；非加权ROE",
        "ratio",
        ni !== null &&
          equity !== null &&
          equity !== 0 &&
          series.NET_INCOME?.unit === scope.security.currency &&
          series.NET_INCOME.input.packet.envelope.source.provider ===
            indicator.packet.envelope.source.provider
          ? ni / equity
          : null,
        "Missing TTM parent net income or nonzero equity comparison.",
      );
    }
    if (!Object.keys(values).length) continue;
    const row: CollectionRow = {
      date,
      periodStart: start,
      asOf: "",
      availableAt: null,
      complete: false,
      values,
    };
    rows.push(row);
    rowDependencies.set(row, dependencies);
  }
  if (!rows.length) return undefined;
  for (const row of rows) {
    const prior = rows.find(
      (r) =>
        r.date === yearBefore(row.date) &&
        r.periodStart === yearBefore(row.periodStart!),
    );
    if (prior) rowDependencies.get(row)!.push(...rowDependencies.get(prior)!);
    for (const [field, value] of Object.entries(row.values)) {
      if (!field.endsWith("_TTM") && !field.endsWith("_QUARTER")) continue;
      if (!columns[field] || columns[field]!.unit === "ratio") continue;
      const growth = `${field}_YOY`;
      columns[growth] = {
        label: `${columns[field]!.label} 同口径同比=(本期-上年同期)/abs(上年同期)×100`,
        unit: "percent",
      };
      const previous = prior?.values[field] ?? null;
      row.values[growth] =
        value !== null && previous !== null && previous !== 0
          ? ((value - previous) / Math.abs(previous)) * 100
          : null;
      if (row.values[growth] === null)
        gaps.push({
          code: "missing",
          field: `/data/rows/${rows.indexOf(row)}/values/${growth}`,
          detail: `Missing comparable prior-year ${field}, current value, or prior denominator is zero.`,
        });
    }
  }
  const valuation = packets.find((p) => p.id === "valuation.history");
  const valuationRows =
    valuation?.envelope.data.rows
      .filter((row) => row.asOf <= scope.cutoff)
      .sort((a, b) => a.date.localeCompare(b.date)) ?? [];
  if (valuation && valuationRows.length) {
    const latestDate = valuationRows.at(-1)!.date;
    attributes.valuationHistoryWindowStart = valuationRows[0]!.date;
    attributes.valuationHistoryWindowEnd = latestDate;
    const values: Record<string, number | null> = {};
    for (const field of ["PE_TTM", "PB_MRQ", "PS_TTM", "PCF_OCF_TTM"]) {
      const samples = valuationRows
        .map((row) => row.values[field])
        .filter(
          (value): value is number => value !== null && value !== undefined,
        )
        .sort((a, b) => a - b);
      const name = `HISTORY_${field}`;
      const middle = Math.floor(samples.length / 2);
      const median = samples.length
        ? samples.length % 2
          ? samples[middle]!
          : (samples[middle - 1]! + samples[middle]!) / 2
        : null;
      const statistics = {
        COUNT: samples.length,
        MIN: samples[0] ?? null,
        MEDIAN: median,
        MAX: samples.at(-1) ?? null,
      };
      for (const [statistic, value] of Object.entries(statistics)) {
        const key = `${name}_${statistic}`;
        columns[key] = {
          label: `valuation.history已有窗口 ${field} 非空样本${statistic}；偶数样本中位数取中间两值平均，窗口见attributes`,
          unit:
            statistic === "COUNT"
              ? "count"
              : (valuation.envelope.data.columns[field]?.unit ?? "multiple"),
        };
        values[key] = value;
        if (value === null)
          gaps.push({
            code: "missing",
            field: `/data/rows/${rows.length}/values/${key}`,
            detail: `No non-null valuation.history ${field} samples in the retained window.`,
          });
      }
    }
    const row: CollectionRow = {
      date: latestDate,
      periodStart: latestDate,
      asOf: "",
      availableAt: null,
      complete: false,
      values,
    };
    rows.push(row);
    rowDependencies.set(
      row,
      valuationRows.map((row) => ({ packet: valuation, row })),
    );
    used.add(valuation);
  }
  for (const row of rows) {
    for (const field of Object.keys(columns)) {
      if (field in row.values) continue;
      row.values[field] = null;
      gaps.push({
        code: "incomparable",
        field: `/data/rows/${rows.indexOf(row)}/values/${field}`,
        detail: "No matching source series for this reporting period.",
      });
    }
  }
  for (const row of rows) {
    const dependencies = rowDependencies.get(row)!;
    row.asOf = dependencies
      .map((i) => i.row.asOf)
      .sort()
      .at(-1)!;
    row.availableAt = dependencies.some((i) => i.row.availableAt === null)
      ? null
      : dependencies
          .map((i) => i.row.availableAt!)
          .sort()
          .at(-1)!;
    row.complete = dependencies.every((i) => i.row.complete);
  }
  const sources = [...used].map((p) => p.envelope);
  for (const p of used) {
    if (financial.includes(p)) continue;
    gaps.push(
      ...p.envelope.gaps.map((g) => ({
        ...g,
        field: "/data",
        detail: `${p.id} ${g.field}: ${g.detail}`,
      })),
    );
  }
  const latest = (field: "asOf" | "retrievedAt") =>
    sources
      .map((e) => e[field])
      .sort()
      .at(-1)!;
  const asOf = latest("asOf");
  return {
    id: "financial.metrics",
    envelope: {
      dataset: "fundamentals",
      data: {
        table: "financial.metrics",
        title: "快照派生财务指标（保留期间、来源单位；缺项见gaps）",
        columns,
        rows,
        currency: scope.security.currency,
        basis: "derived_period_metrics",
        attributes: {
          ...attributes,
          sources: [...used]
            .map(
              (p) =>
                `${p.id}: ${p.envelope.source.provider} ${p.envelope.source.url}`,
            )
            .join("; "),
        },
      },
      source: {
        provider: "stock-research",
        url: "urn:stock-research:financial-metrics:v1",
        adapterVersion: "1",
        normalizationVersion: "1",
      },
      asOf,
      availableAt: sources.some((e) => e.availableAt === null)
        ? null
        : sources
            .map((e) => e.availableAt!)
            .sort()
            .at(-1)!,
      retrievedAt: latest("retrievedAt"),
      cutoff: scope.cutoff,
      ageMs: Date.parse(scope.cutoff) - Date.parse(asOf),
      stale: sources.some((e) => e.stale),
      historicalKnowledge: sources.every(
        (e) => e.historicalKnowledge === "verified",
      )
        ? "verified"
        : "unverified",
      gaps,
    },
  };
}
