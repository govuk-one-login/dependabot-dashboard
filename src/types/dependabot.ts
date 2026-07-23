export type PrStatus = "passing" | "failing" | "outdated";

export interface ActionState {
  approving: boolean;
  approved: boolean;
  merging: boolean;
  merged: boolean;
  mergeError: string | null;
  updating: boolean;
  updated: boolean;
  approveError: string | null;
  updateError: string | null;
  // Planning phase
  planning: boolean;
  planLog: string[];
  planText: string;
  pendingPlanJobId: string | null;
  planError: string | null;
  showPlanLog: boolean;
  replanComment: string;
  showReplanInput: boolean;
  // Fix phase
  fixing: boolean;
  stopping: boolean;
  fixed: boolean;
  fixError: string | null;
  fixLog: string[];
  fixSummary: string;
  showFixLog: boolean;
  pendingJobId: string | null;
  fixDiff: string;
  pushing: boolean;
  pushError: string | null;
  discarded: boolean;
  deleting: boolean;
  deleted: boolean;
  deleteError: string | null;
  recreating: boolean;
  recreated: boolean;
  recreateError: string | null;
  slackCopied: boolean;
  extraInstructions: string;
  showInstructionsInput: boolean;
}

export function createActionState(): ActionState {
  return {
    approving: false,
    approved: false,
    merging: false,
    merged: false,
    mergeError: null,
    updating: false,
    updated: false,
    approveError: null,
    updateError: null,
    planning: false,
    planLog: [],
    planText: "",
    pendingPlanJobId: null,
    planError: null,
    showPlanLog: false,
    replanComment: "",
    showReplanInput: false,
    fixing: false,
    stopping: false,
    fixed: false,
    fixError: null,
    fixLog: [],
    fixSummary: "",
    showFixLog: false,
    pendingJobId: null,
    fixDiff: "",
    pushing: false,
    pushError: null,
    discarded: false,
    deleting: false,
    deleted: false,
    deleteError: null,
    recreating: false,
    recreated: false,
    recreateError: null,
    slackCopied: false,
    extraInstructions: "",
    showInstructionsInput: false,
  };
}
