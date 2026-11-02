import type { RoleId } from "@/src/lib/script/scriptTypes";

export type GamePhase =
  | "role_selection"
  | "reading"
  | "ai_internal_reading"
  | "share_round"
  | "free_discussion"
  | "dm_question"
  | "act_summary"
  | "finished";

export type DMFlowCursorPhase = "opening" | "act" | "ending";

export type DMFlowWaitingFor =
  | "none"
  | "player_read_done"
  | "ai_internal_reading_done"
  | "all_shares_done"
  | "discussion_close"
  | "user_input"
  | "manual_continue"
  | "clue_release"
  | "act_transition"
  | "test_scope_end";

export type PublicMessageEvidence = { requirementIndex: number; messageId: string; quote: string };

export type DMFlowCursor = {
  knowledgeReleaseReceipts?: { definitionId: string; definitionVersion: number; nodeId: string; actId: string; releasedAt: string }[];
  clueGrants?: import("@/src/lib/schemas/runtimeClueSchema").ClueGrantReceipt[];
  clueSharePermissions?: import("@/src/lib/schemas/runtimeClueSchema").ClueSharePermission[];
  cluePublications?: import("@/src/lib/schemas/runtimeClueSchema").CluePublication[];
  groupMatchingReceipts?: import("@/src/lib/schemas/runtimeChoiceSchema").GroupMatchingReceipt[];
  groupMatchingDiscussionNodeIds?: string[];
  choiceReceipts?: import("@/src/lib/schemas/runtimeChoiceSchema").RuntimeChoiceReceipt[];
  choiceAttempts?: import("@/src/lib/schemas/runtimeChoiceSchema").RuntimeChoiceAttempt[];
  textPresentation?: { nodeId: string; token: string; kind: "start" | "continue" | "transition"; offset: number; confirmed: boolean };
  lifecycle?: {
    version: 1;
    definitionId: string;
    definitionVersion: number;
    recoveryKey: string;
    recoveryStatus: "healthy" | "recovered" | "attention_required";
    recoveryNeedsAttention?: string;
    authorizedTrigger?: string;
    lastEvaluation?: {
      id: string; trigger: string; source: string; evaluatedAt: string;
      result: "executed" | "waiting" | "advanced" | "skipped" | "recovery" | "failed";
      reason: string; beforeNode: string | null; afterNode: string | null; messageId: string | null;
    };
  };
  actIndex: number;
  nodeIndex: number;
  nodeId?: string;
  phase: DMFlowCursorPhase;
  waitingFor: DMFlowWaitingFor;
  consumedNodeIds: string[];
  completedNodeIds: string[];
  triggeredRuleIds: string[];
  lastTriggeredRuleId?: string;
  lastTriggeredRuleReason?: string;
  lastExecutedNodeId?: string;
  lastAdvanceReason?: string;
  lastAdvancedAt?: string;
  stopReason?: string;
  pendingDMQuestion?: PendingDMQuestion | null;
  publicPointCoverage?: { nodeId: string; points: Array<{ ruleId: string; status: "mentioned" | "missing" | "unknown"; evidenceMessageIds: string[]; evidence?: PublicMessageEvidence[] }>;
    inputKey?: string; observedAt?: string; expiresAt?: string };
  conditionObservations?: Record<string, { verdict: boolean | null; evidenceMessageIds: string[]; evidence?: PublicMessageEvidence[]; inputKey?: string; observedAt?: string; expiresAt?: string }>;
  lastPendingQuestionEvaluation?: PendingDMQuestionEvaluation | null;
  lastAutoExecutedNodeId?: string | null;
  lastAutoExecutedAt?: string | null;
  warnings: string[];
};

export type PendingDMQuestion = {
  skippedRoleNames?: string[];
  responseAttempts?: number;
  responseLastError?: string | null;
  publicPointRuleId?: string;
  textInteraction?: boolean;
  closeReason?: "response_received" | "timeout" | "soft_point_timeout" | "ai_response_skipped";
  messageId: string;
  nodeId?: string;
  actIndex: number;
  questionText: string;
  targetRoleNames: string[];
  expectedTopics: string[];
  askedAt: string;
  answeredByRoleNames: string[];
  cueCount: number;
  status: "waiting" | "partial_answered" | "answered" | "closed";
};

export type PendingDMQuestionEvaluation = {
  latestMessageId: string;
  answered: boolean;
  partial: boolean;
  answeredTopics: string[];
  missingTopics: string[];
  shouldCueAnotherRole: boolean;
  cueTargetRoleName?: string;
  shouldAskFollowup: boolean;
  shouldAdvanceFlow: boolean;
  reason: string;
  evaluatedAt: string;
};

export type SpeakerType = "dm" | "user" | "ai_player" | "system";

export type SpeechAct =
  | "system"
  | "share"
  | "question"
  | "answer"
  | "answer_dm_question"
  | "answer_user_question"
  | "answer_group_question"
  | "challenge"
  | "empathy"
  | "clarify"
  | "emotion"
  | "dm_prompt"
  | "dm_directed_question"
  | "group_question"
  | "discussion_invitation"
  | "summary"
  | "transition"
  | "notice"
  | "statement";

export type InternalReadingStatus = "idle" | "running" | "completed" | "failed";

export type AiSharePlan = {
  must_mention: string[];
  emotional_tone: string;
  safe_boundaries: string[];
  possible_opening: string | null;
};

export type ReactionProfile = {
  known_event_tags: string[];
  related_role_ids: RoleId[];
  emotional_triggers: string[];
  unresolved_questions: string[];
  current_act_speakable_topics: string[];
  forbidden_boundaries_summary: string[];
};

export type InternalReadingRecord = {
  sourceReadings?: Array<{ sourceId: string; completedAt: string }>;
  status: InternalReadingStatus;
  agentRunId?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type GameSession = {
  publicStoryBoardEnabled?: boolean;
  runtimeMode?: import("@/src/lib/services/runtimeMode").RuntimeMode;
  gameId: string;
  scriptPackageId: string | null;
  runtimeDefinitionId?: string | null;
  testMode?: boolean;
  runtimeScope?: unknown | null;
  currentActIndex: number;
  totalActs: number;
  currentActId: string;
  currentPhase: GamePhase;
  userRoleId: RoleId | null;
  aiRoleIds: RoleId[];
  userReadActIds: string[];
  currentShareIndex: number;
  discussionTurnCount: number;
  maxDiscussionTurns: number;
  dmFlowCursor?: DMFlowCursor | null;
};

export type RoleMemory = {
  private_memory_so_far: string[];
  beliefs: string[];
  emotional_state: string;
  unresolved_questions?: string[];
  share_intentions?: {
    must_share_summary: string[];
    may_share_summary: string[];
    must_not_share_reminder: string[];
  };
  share_plan?: AiSharePlan;
  reaction_profile?: ReactionProfile;
  internal_readings?: Record<string, InternalReadingRecord>;
  style_seed: string;
};

export type PublicStoryBoard = {
  known_facts: string[];
  timeline: string[];
  relationships: string[];
  open_questions: string[];
  contradictions: string[];
  emotional_bonds: string[];
  discussed_questions: string[];
  current_conflicts: string[];
  lastUpdatedMessageId?: string | null;
  lastUpdatedActId?: string | null;
  lastUpdatedMessageCreatedAt?: string | null;
  visibility?: "public" | "public_opening";
};

export type PublicMessage = {
  id: string;
  speakerRoleId: RoleId | "dm";
  content: string;
};

export type MessageMetadata = {
  discussionAddressingMode?: "public" | "reply";
  discussionSourceMessageId?: string;
  discussionPublicationMode?: "act_share" | "reply";
  discussionFollowupAllowed?: boolean;
  runtimeInputPolicy?: "answer_only" | "choice_only" | "directed_sharing";
  clueId?: string;
  groupMatchingDiscussion?: boolean;
  groupMatchingResult?: boolean;
  choiceId?: string;
  round?: number;

  textUnitEnd?: number;
  textInteraction?: boolean;
  act_id?: string;
  runtimeDefinitionId?: string;
  runtimeDefinitionVersion?: number;
  executionMode?: import("@/src/lib/services/runtimeMode").RuntimeMode;
  dmRunId?: string;
  traceId?: string;
  lifecycleKey?: string;
  revealed_facts: string[];
  emotional_points: string[];
  questions_raised: string[];
  mentioned_role_ids: RoleId[];
  event_tags: string[];
  topic_tags: string[];
  source?: "script_fixed" | "script_guided" | "system_fallback" | "fallback_must_share" | "conditional_rule";
  dm_flow_node?: string;
  sourceNodeId?: string;
  sourceNodeType?: string;
  sourceMode?: "script_fixed" | "script_guided" | "system_fallback" | "conditional_rule";
  conditionalRuleId?: string;
  trigger?: string;
  storyBoardEligible?: boolean;
  next_action?: "advance_phase" | "wait_for_user" | "none";
  checkerFailedBeforeFallback?: boolean;
  checkerFailureReasons?: string[];
  checkerFailureViolations?: string[];
};

export type Message = {
  message_id: string;
  speaker_type: SpeakerType;
  speaker_role_id: RoleId | "dm" | "system" | null;
  speaker_name: string | null;
  target_role_ids?: RoleId[];
  reply_to_message_id?: string | null;
  phase: GamePhase;
  speech_act: SpeechAct;
  content: string;
  metadata: MessageMetadata;
  story_board_processed_at?: Date | null;
  story_board_status?: "not_queued" | "pending" | "processing" | "completed" | "skipped" | "failed";
  story_board_attempt_count?: number;
  story_board_error?: string | null;
  created_at?: Date;
};

export type GameRuntimeContext = {
  roleMemories: Partial<Record<RoleId, RoleMemory>>;
  publicStoryBoard: PublicStoryBoard;
  recentPublicMessages: PublicMessage[];
};
