export const POLICY_LOGO = "⛨";
export const POLICY_NAME = `${POLICY_LOGO} OMP Semantic Policy`;

export function brandPolicyText(text: string): string {
  return `${POLICY_LOGO} ${text}`;
}
