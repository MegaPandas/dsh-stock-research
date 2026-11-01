export const sources = [
  ["yahoo", "Yahoo 行情", "美股行情与部分市场基准"],
  ["eastmoney-market", "东方财富行情", "A 股行情、估值与固定采集"],
  ["tencent", "腾讯行情", "行情查询与日线备用来源"],
  ["eastmoney-income", "东方财富财务", "A 股财务指标与报表"],
  ["sina", "新浪财经", "财务查询、行情均线及个股、指数、部分国际基准备用"],
  ["xueqiu", "雪球", "默认关闭，配置 Cookie 后作为 A 股行情与财务备用来源"],
  ["china-macro", "中国宏观", "国内宏观固定采集"],
  ["benchmarks", "市场基准", "指数、汇率、黄金与国债"],
  ["fred", "FRED", "美国宏观序列"],
  ["dsh-web", "公开信息搜索", "复用 DSH 搜索服务"],
  ["sec", "SEC", "美国发行人标准财务字段"],
] as const;
export const datasetLabels = {
  market: "行情",
  fundamentals: "财务",
  macro: "宏观",
  research: "公开研究",
};
export const xueqiuCookieFields = [
  { name: "xq_a_token", label: "访问令牌（xq_a_token）", type: "password" },
  { name: "u", label: "用户 ID（u）", type: "password" },
  { name: "xq_is_login", label: "登录标记（xq_is_login）", type: "text" },
] as const;

export function xueqiuCookieValue(
  cookie: string | undefined,
  name: string,
): string {
  const entry = cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return entry?.slice(name.length + 1) ?? "";
}
