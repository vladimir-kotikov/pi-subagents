export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";

export interface PromptTemplateDelegationRequest {
	requestId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	model: string;
	cwd: string;
}

export interface PromptTemplateDelegationResponse extends PromptTemplateDelegationRequest {
	messages: unknown[];
	isError: boolean;
	errorText?: string;
}

export interface PromptTemplateDelegationUpdate {
	requestId: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

export interface PromptTemplateBridgeEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface PromptTemplateBridgeResult {
	isError?: boolean;
	content?: unknown;
	details?: {
		results?: Array<{
			messages?: unknown[];
		}>;
		progress?: Array<{
			currentTool?: string;
			currentToolArgs?: string;
			recentOutput?: string[];
			toolCount?: number;
		}>;
	};
}

export interface PromptTemplateBridgeOptions<Ctx extends { cwd?: string }> {
	events: PromptTemplateBridgeEvents;
	getContext: () => Ctx | null;
	execute: (
		requestId: string,
		request: PromptTemplateDelegationRequest,
		signal: AbortSignal,
		ctx: Ctx,
		onUpdate: (result: PromptTemplateBridgeResult) => void,
	) => Promise<PromptTemplateBridgeResult>;
}

export function parsePromptTemplateRequest(data: unknown): PromptTemplateDelegationRequest | undefined {
	if (!data || typeof data !== "object") return undefined;
	const value = data as Partial<PromptTemplateDelegationRequest>;
	if (!value.requestId || !value.agent || !value.task || !value.model || !value.cwd) return undefined;
	if (value.context !== "fresh" && value.context !== "fork") return undefined;
	return {
		requestId: value.requestId,
		agent: value.agent,
		task: value.task,
		context: value.context,
		model: value.model,
		cwd: value.cwd,
	};
}

export function firstTextContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ((part as { type?: string }).type !== "text") continue;
		const text = (part as { text?: unknown }).text;
		if (typeof text === "string" && text.trim()) return text.trim();
	}
	return undefined;
}

function toDelegationUpdate(requestId: string, update: PromptTemplateBridgeResult): PromptTemplateDelegationUpdate | undefined {
	const progress = update.details?.progress?.[0];
	if (!progress) return undefined;
	const lastOutput = progress.recentOutput?.[progress.recentOutput.length - 1];
	return {
		requestId,
		currentTool: progress.currentTool,
		currentToolArgs: progress.currentToolArgs,
		recentOutput: lastOutput && lastOutput !== "(running...)" ? lastOutput : undefined,
		toolCount: progress.toolCount,
		durationMs: (progress as { durationMs?: number }).durationMs,
		tokens: (progress as { tokens?: number }).tokens,
	};
}

export function registerPromptTemplateDelegationBridge<Ctx extends { cwd?: string }>(
	options: PromptTemplateBridgeOptions<Ctx>,
): {
	cancelAll: () => void;
	dispose: () => void;
} {
	const controllers = new Map<string, AbortController>();
	const pendingCancels = new Set<string>();
	const subscriptions: Array<() => void> = [];

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	subscribe(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
		if (!data || typeof data !== "object") return;
		const requestId = (data as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string") return;
		const controller = controllers.get(requestId);
		if (controller) {
			controller.abort();
			return;
		}
		pendingCancels.add(requestId);
	});

	subscribe(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, async (data) => {
		const request = parsePromptTemplateRequest(data);
		if (!request) return;

		const ctx = options.getContext();
		if (!ctx) {
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: "No active extension context for delegated subagent execution.",
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
			return;
		}

		if (typeof ctx.cwd === "string" && ctx.cwd !== request.cwd) {
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: `Delegated request cwd mismatch: active context is '${ctx.cwd}' but request asked for '${request.cwd}'. Retry from the target session/cwd.`,
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
			return;
		}

		const controller = new AbortController();
		controllers.set(request.requestId, controller);

		if (pendingCancels.delete(request.requestId)) {
			controller.abort();
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: "Delegated prompt cancelled.",
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
			controllers.delete(request.requestId);
			return;
		}

		options.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });

		try {
			const result = await options.execute(
				request.requestId,
				request,
				controller.signal,
				ctx,
				(update) => {
					const payload = toDelegationUpdate(request.requestId, update);
					if (!payload) return;
					options.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, payload);
				},
			);
			const messages = result.details?.results?.[0]?.messages ?? [];
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages,
				isError: result.isError === true,
				errorText: result.isError ? firstTextContent(result.content) : undefined,
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
		} catch (error) {
			const response: PromptTemplateDelegationResponse = {
				...request,
				messages: [],
				isError: true,
				errorText: error instanceof Error ? error.message : String(error),
			};
			options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, response);
		} finally {
			controllers.delete(request.requestId);
		}
	});

	return {
		cancelAll: () => {
			for (const controller of controllers.values()) {
				controller.abort();
			}
			controllers.clear();
			pendingCancels.clear();
		},
		dispose: () => {
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
			pendingCancels.clear();
		},
	};
}
