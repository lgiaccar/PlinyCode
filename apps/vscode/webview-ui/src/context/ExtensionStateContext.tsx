import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DEFAULT_PLATFORM, type ExtensionState } from "@shared/ExtensionMessage"
import { DEFAULT_MCP_DISPLAY_MODE } from "@shared/McpDisplayMode"
import { EmptyRequest } from "@shared/proto/cline/common"
import type { ProviderModelsResponse } from "@shared/proto/cline/models"
import type { TerminalProfile } from "@shared/proto/cline/state"
import { convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { fromProtobufModels } from "@shared/proto-conversions/models/typeConversion"
import type React from "react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import type { ModelInfo } from "../../../src/shared/api"
import { Environment } from "../../../src/shared/config-types"
import type { McpServer, McpViewTab } from "../../../src/shared/mcp"
import {
	createReplicaState,
	type ReplicaState,
	applyMessage as reducerApplyMessage,
	applyStateSnapshot as reducerApplyStateSnapshot,
} from "../components/chat/chat-view/messageReducer"
import { McpServiceClient, StateServiceClient, UiServiceClient } from "../services/grpc-client"

export type ProviderId = string

interface ProviderModelsState {
	providerId: ProviderId
	models: Record<string, ModelInfo>
	defaultModelId: string
	configFingerprint: string
	requestId: string
	source?: string
	fetchedAt: number
	isLoading: boolean
	isStale: boolean
	error?: string
}

export interface ExtensionStateContextType extends ExtensionState {
	didHydrateState: boolean
	showWelcome: boolean
	providerModelsByProvider: Partial<Record<ProviderId, ProviderModelsState>>
	latestModelRequestIdByProvider: Partial<Record<ProviderId, string>>
	mcpServers: McpServer[]
	totalTasksSize: number | null

	availableTerminalProfiles: TerminalProfile[]

	// View state
	showMcp: boolean
	mcpTab?: McpViewTab
	showSettings: boolean
	settingsTargetSection?: string
	settingsInitialModelTab?: "recommended" | "free"
	showHistory: boolean
	expandTaskHeader: boolean

	// Setters
	setMcpServers: (value: McpServer[]) => void
	setGlobalClineRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalClineRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalCursorRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalWindsurfRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalAgentsRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalCopilotRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGlobalWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGlobalSkillsToggles: (toggles: Record<string, boolean>) => void
	setLocalSkillsToggles: (toggles: Record<string, boolean>) => void
	setTotalTasksSize: (value: number | null) => void
	setExpandTaskHeader: (value: boolean) => void
	setShowWelcome: (value: boolean) => void
	startProviderModelsRequest: (providerId: ProviderId, requestId: string) => void
	applyProviderModelsResponse: (response: ProviderModelsResponse) => void

	// Navigation state setters
	setShowMcp: (value: boolean) => void
	setMcpTab: (tab?: McpViewTab) => void

	// Navigation functions
	navigateToMcp: (tab?: McpViewTab) => void
	navigateToSettings: (targetSection?: string) => void
	navigateToSettingsModelPicker: (opts: { targetSection?: string; initialModelTab?: "recommended" | "free" }) => void
	navigateToHistory: () => void
	navigateToChat: () => void

	// Hide functions
	hideSettings: () => void
	hideHistory: () => void
	closeMcpView: () => void

	// Event callbacks
	onRelinquishControl: (callback: () => void) => () => void
}

export const ExtensionStateContext = createContext<ExtensionStateContextType | undefined>(undefined)

export const ExtensionStateContextProvider: React.FC<{
	children: React.ReactNode
}> = ({ children }) => {
	// UI view state
	const [showMcp, setShowMcp] = useState(false)
	const [mcpTab, setMcpTab] = useState<McpViewTab | undefined>(undefined)
	const [showSettings, setShowSettings] = useState(false)
	const [settingsTargetSection, setSettingsTargetSection] = useState<string | undefined>(undefined)
	const [settingsInitialModelTab, setSettingsInitialModelTab] = useState<"recommended" | "free" | undefined>(undefined)
	const [showHistory, setShowHistory] = useState(false)

	// Helper for MCP view
	const closeMcpView = useCallback(() => {
		setShowMcp(false)
		setMcpTab(undefined)
	}, [setShowMcp, setMcpTab])

	// Hide functions
	const hideSettings = useCallback(() => {
		setShowSettings(false)
		setSettingsTargetSection(undefined)
		setSettingsInitialModelTab(undefined)
	}, [])
	const hideHistory = useCallback(() => setShowHistory(false), [setShowHistory])

	// Navigation functions
	const navigateToMcp = useCallback(
		(tab?: McpViewTab) => {
			setShowSettings(false)
			setShowHistory(false)
			setMcpTab(tab)
			setShowMcp(true)
		},
		[setMcpTab, setShowSettings, setShowHistory],
	)

	const navigateToSettings = useCallback(
		(targetSection?: string) => {
			setShowHistory(false)
			closeMcpView()
			setSettingsTargetSection(targetSection)
			setSettingsInitialModelTab(undefined)
			setShowSettings(true)
		},
		[closeMcpView],
	)

	const navigateToSettingsModelPicker = useCallback(
		(opts: { targetSection?: string; initialModelTab?: "recommended" | "free" }) => {
			setShowHistory(false)
			closeMcpView()
			setSettingsTargetSection(opts.targetSection)
			setSettingsInitialModelTab(opts.initialModelTab)
			setShowSettings(true)
		},
		[closeMcpView],
	)

	const navigateToHistory = useCallback(() => {
		setShowSettings(false)
		closeMcpView()
		setShowHistory(true)
	}, [setShowSettings, closeMcpView, setShowHistory])

	const navigateToChat = useCallback(() => {
		setShowSettings(false)
		closeMcpView()
		setShowHistory(false)
	}, [setShowSettings, closeMcpView, setShowHistory])

	const [state, setState] = useState<ExtensionState>({
		version: "",
		clineMessages: [],
		queuedPrompts: [],
		taskHistory: [],
		autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
		preferredLanguage: "English",
		mode: "act",
		platform: DEFAULT_PLATFORM,
		environment: Environment.production,
		distinctId: "",
		planActSeparateModelsSetting: true,
		enableCheckpointsSetting: true,
		mcpDisplayMode: DEFAULT_MCP_DISPLAY_MODE,
		globalClineRulesToggles: {},
		localClineRulesToggles: {},
		localCursorRulesToggles: {},
		localWindsurfRulesToggles: {},
		localAgentsRulesToggles: {},
		localCopilotRulesToggles: {},
		localWorkflowToggles: {},
		globalWorkflowToggles: {},
		shellIntegrationTimeout: 4000,
		terminalReuseEnabled: true,
		vscodeTerminalExecutionMode: "vscodeTerminal",
		defaultTerminalProfile: "default",
		welcomeViewCompleted: false,
		mcpResponsesCollapsed: false, // Default value (expanded), will be overwritten by extension state
		chatInputMaxRows: 10, // Default value, will be overwritten by extension state
		useAutoCondense: true,
		compactionStrategy: "basic",
		webSearchEnabled: false,
		prereleaseUpdatesEnabled: false,
		conversationSpendingLimit: 5,
		subagentsEnabled: true,
		favoritedModelIds: [],
		backgroundCommandRunning: false,
		backgroundCommandTaskId: undefined,
		foregroundCommandRunning: false,
		backgroundTasks: [],
		backgroundEditEnabled: false,
		showFeatureTips: false,
		globalSkillsToggles: {},
		localSkillsToggles: {},

		// NEW: Add workspace information with defaults
		workspaceRoots: [],
		primaryRootIndex: 0,
		isMultiRootWorkspace: false,
		hooksEnabled: false,
	})
	const [expandTaskHeader, setExpandTaskHeader] = useState(true)
	const [didHydrateState, setDidHydrateState] = useState(false)

	const [showWelcome, setShowWelcome] = useState(false)

	const [totalTasksSize, setTotalTasksSize] = useState<number | null>(null)
	const [availableTerminalProfiles, setAvailableTerminalProfiles] = useState<TerminalProfile[]>([])

	const [providerModelsByProvider, setProviderModelsByProvider] = useState<Partial<Record<ProviderId, ProviderModelsState>>>({})
	const [latestModelRequestIdByProvider, setLatestModelRequestIdByProvider] = useState<Partial<Record<ProviderId, string>>>({})
	const latestModelRequestIdByProviderRef = useRef<Partial<Record<ProviderId, string>>>({})
	const [mcpServers, setMcpServers] = useState<McpServer[]>([])

	const startProviderModelsRequest = useCallback((providerId: ProviderId, requestId: string) => {
		latestModelRequestIdByProviderRef.current = { ...latestModelRequestIdByProviderRef.current, [providerId]: requestId }
		setLatestModelRequestIdByProvider((prev) => ({ ...prev, [providerId]: requestId }))
		setProviderModelsByProvider((prev) => ({
			...prev,
			[providerId]: {
				...(prev[providerId] ?? {
					providerId,
					models: {},
					defaultModelId: "",
					configFingerprint: "",
					fetchedAt: 0,
					isStale: false,
				}),
				providerId,
				requestId,
				isLoading: true,
				error: undefined,
			},
		}))
	}, [])

	const applyProviderModelsResponse = useCallback((response: ProviderModelsResponse) => {
		setProviderModelsByProvider((prevModels) => {
			const latestRequestId = latestModelRequestIdByProviderRef.current[response.providerId]
			if (latestRequestId !== response.requestId) {
				console.debug("Dropping stale provider models response", {
					providerId: response.providerId,
					requestId: response.requestId,
					latestRequestId,
				})
				return prevModels
			}

			return {
				...prevModels,
				[response.providerId]: {
					providerId: response.providerId,
					models: response.ok ? fromProtobufModels(response.models) : {},
					defaultModelId: response.defaultModelId ?? "",
					configFingerprint: response.configFingerprint,
					requestId: response.requestId,
					source: response.source,
					fetchedAt: response.fetchedAt,
					isLoading: false,
					isStale: false,
					error: response.ok ? undefined : response.error?.message,
				},
			}
		})
	}, [])

	// References to store subscription cancellation functions
	const stateSubscriptionRef = useRef<(() => void) | null>(null)

	const mcpButtonUnsubscribeRef = useRef<(() => void) | null>(null)
	const historyButtonClickedSubscriptionRef = useRef<(() => void) | null>(null)
	const chatButtonUnsubscribeRef = useRef<(() => void) | null>(null)
	const settingsButtonClickedSubscriptionRef = useRef<(() => void) | null>(null)
	const partialMessageUnsubscribeRef = useRef<(() => void) | null>(null)
	const workspaceUpdatesUnsubscribeRef = useRef<(() => void) | null>(null)
	const relinquishControlUnsubscribeRef = useRef<(() => void) | null>(null)

	// Add ref for callbacks
	const relinquishControlCallbacks = useRef<Set<() => void>>(new Set())

	// Create hook function
	const onRelinquishControl = useCallback((callback: () => void) => {
		relinquishControlCallbacks.current.add(callback)
		return () => {
			relinquishControlCallbacks.current.delete(callback)
		}
	}, [])
	const mcpServersSubscriptionRef = useRef<(() => void) | null>(null)
	// Convergent-replica state for clineMessages. The partial-message stream and the full state
	// snapshots both feed this reducer so the transcript converges correctly regardless of
	// arrival order, duplication, or loss. See messageReducer.ts.
	const replicaRef = useRef<ReplicaState>(createReplicaState())

	// Subscribe to state updates and UI events using the gRPC streaming API
	useEffect(() => {
		// Set up state subscription
		stateSubscriptionRef.current = StateServiceClient.subscribeToState(EmptyRequest.create({}), {
			onResponse: (response: any) => {
				if (response.stateJson) {
					try {
						const stateData = JSON.parse(response.stateJson) as ExtensionState
						setState((prevState) => {
							// Versioning logic for autoApprovalSettings
							const incomingVersion = stateData.autoApprovalSettings?.version ?? 1
							const currentVersion = prevState.autoApprovalSettings?.version ?? 1
							const shouldUpdateAutoApproval = incomingVersion > currentVersion

							// Route the snapshot's transcript through the convergent-replica reducer:
							// merge by ts/seq within the same epoch (never truncate), replace on a
							// newer epoch, ignore stale/older snapshots. Unstamped (classic/legacy)
							// state defaults to epoch 0 / version 0, which merges.
							replicaRef.current = reducerApplyStateSnapshot(
								replicaRef.current,
								stateData.clineMessages ?? [],
								stateData.epoch ?? 0,
								stateData.stateVersion ?? 0,
								stateData.turnState,
							)
							stateData.clineMessages = replicaRef.current.messages
							// Use the seq-gated turnState from the replica, NOT the raw snapshot's, so a
							// late/stale snapshot carrying an older phase (e.g. "idle") cannot revert a
							// newer phase (e.g. "streaming") and hide the Cancel button. Falls back to
							// undefined for classic/legacy state.
							stateData.turnState = replicaRef.current.turnState

							const newState = {
								...stateData,
								autoApprovalSettings: shouldUpdateAutoApproval
									? stateData.autoApprovalSettings
									: prevState.autoApprovalSettings,
							}

							// PlinyCode skips Cline account onboarding entirely.
							setShowWelcome(false)

							setDidHydrateState(true)

							return newState
						})
					} catch (error) {
						console.error("Error parsing state JSON:", error)
						console.log("[DEBUG] ERR getting state", error)
					}
				}
				console.log('[DEBUG] ended "got subscribed state"')
			},
			onError: (error: any) => {
				console.error("Error in state subscription:", error)
			},
			onComplete: () => {
				console.log("State subscription completed")
			},
		})

		// Subscribe to MCP button clicked events with webview type
		mcpButtonUnsubscribeRef.current = UiServiceClient.subscribeToMcpButtonClicked(
			{},
			{
				onResponse: () => {
					console.log("[DEBUG] Received mcpButtonClicked event from gRPC stream")
					navigateToMcp()
				},
				onError: (error: any) => {
					console.error("Error in mcpButtonClicked subscription:", error)
				},
				onComplete: () => {
					console.log("mcpButtonClicked subscription completed")
				},
			},
		)

		// Set up history button clicked subscription with webview type
		historyButtonClickedSubscriptionRef.current = UiServiceClient.subscribeToHistoryButtonClicked(
			{},
			{
				onResponse: () => {
					// When history button is clicked, navigate to history view
					console.log("[DEBUG] Received history button clicked event from gRPC stream")
					navigateToHistory()
				},
				onError: (error: any) => {
					console.error("Error in history button clicked subscription:", error)
				},
				onComplete: () => {
					console.log("History button clicked subscription completed")
				},
			},
		)

		// Subscribe to chat button clicked events with webview type
		chatButtonUnsubscribeRef.current = UiServiceClient.subscribeToChatButtonClicked(
			{},
			{
				onResponse: () => {
					// When chat button is clicked, navigate to chat
					console.log("[DEBUG] Received chat button clicked event from gRPC stream")
					navigateToChat()
				},
				onError: (error: any) => {
					console.error("Error in chat button subscription:", error)
				},
				onComplete: () => {},
			},
		)

		// Subscribe to MCP servers updates
		mcpServersSubscriptionRef.current = McpServiceClient.subscribeToMcpServers(EmptyRequest.create(), {
			onResponse: (response: any) => {
				console.log("[DEBUG] Received MCP servers update from gRPC stream")
				if (response.mcpServers) {
					setMcpServers(convertProtoMcpServersToMcpServers(response.mcpServers))
				}
			},
			onError: (error: any) => {
				console.error("Error in MCP servers subscription:", error)
			},
			onComplete: () => {
				console.log("MCP servers subscription completed")
			},
		})

		// Set up settings button clicked subscription
		settingsButtonClickedSubscriptionRef.current = UiServiceClient.subscribeToSettingsButtonClicked(EmptyRequest.create({}), {
			onResponse: () => {
				// When settings button is clicked, navigate to settings
				navigateToSettings()
			},
			onError: (error: any) => {
				console.error("Error in settings button clicked subscription:", error)
			},
			onComplete: () => {
				console.log("Settings button clicked subscription completed")
			},
		})

		// Subscribe to partial message events
		partialMessageUnsubscribeRef.current = UiServiceClient.subscribeToPartialMessage(EmptyRequest.create({}), {
			onResponse: (protoMessage: any) => {
				try {
					// Validate critical fields
					if (!protoMessage.ts || protoMessage.ts <= 0) {
						console.error("Invalid timestamp in partial message:", protoMessage)
						return
					}

					const partialMessage = convertProtoToClineMessage(protoMessage)
					setState((prevState) => {
						// Route through the convergent-replica reducer: merge by ts keeping the
						// higher seq, fence stale epochs, never let an out-of-order or duplicate
						// delivery corrupt the transcript. Unstamped (classic/legacy) messages
						// default to epoch 0 and merge by ts as before.
						const before = replicaRef.current
						replicaRef.current = reducerApplyMessage(before, partialMessage)
						if (replicaRef.current === before) {
							// Stale/ignored — no change.
							return prevState
						}
						return { ...prevState, clineMessages: replicaRef.current.messages }
					})
				} catch (error) {
					console.error("Failed to process partial message:", error, protoMessage)
				}
			},
			onError: (error: any) => {
				console.error("Error in partialMessage subscription:", error)
			},
			onComplete: () => {
				console.log("[DEBUG] partialMessage subscription completed")
			},
		})

		// Initialize webview using gRPC
		UiServiceClient.initializeWebview(EmptyRequest.create({}))
			.then(() => {
				console.log("[DEBUG] Webview initialization completed via gRPC")
			})
			.catch((error) => {
				console.error("Failed to initialize webview via gRPC:", error)
			})

		// Fetch available terminal profiles on launch
		StateServiceClient.getAvailableTerminalProfiles(EmptyRequest.create({}))
			.then((response) => {
				setAvailableTerminalProfiles(response.profiles)
			})
			.catch((error) => {
				console.error("Failed to fetch available terminal profiles:", error)
			})

		// Subscribe to relinquish control events
		relinquishControlUnsubscribeRef.current = UiServiceClient.subscribeToRelinquishControl(EmptyRequest.create({}), {
			onResponse: () => {
				// Call all registered callbacks
				relinquishControlCallbacks.current.forEach((callback) => {
					callback()
				})
			},
			onError: (error: any) => {
				console.error("Error in relinquishControl subscription:", error)
			},
			onComplete: () => {},
		})

		// Clean up subscriptions when component unmounts
		return () => {
			if (stateSubscriptionRef.current) {
				stateSubscriptionRef.current()
				stateSubscriptionRef.current = null
			}
			if (mcpButtonUnsubscribeRef.current) {
				mcpButtonUnsubscribeRef.current()
				mcpButtonUnsubscribeRef.current = null
			}
			if (historyButtonClickedSubscriptionRef.current) {
				historyButtonClickedSubscriptionRef.current()
				historyButtonClickedSubscriptionRef.current = null
			}
			if (chatButtonUnsubscribeRef.current) {
				chatButtonUnsubscribeRef.current()
				chatButtonUnsubscribeRef.current = null
			}
			if (settingsButtonClickedSubscriptionRef.current) {
				settingsButtonClickedSubscriptionRef.current()
				settingsButtonClickedSubscriptionRef.current = null
			}
			if (partialMessageUnsubscribeRef.current) {
				partialMessageUnsubscribeRef.current()
				partialMessageUnsubscribeRef.current = null
			}
			if (workspaceUpdatesUnsubscribeRef.current) {
				workspaceUpdatesUnsubscribeRef.current()
				workspaceUpdatesUnsubscribeRef.current = null
			}
			if (relinquishControlUnsubscribeRef.current) {
				relinquishControlUnsubscribeRef.current()
				relinquishControlUnsubscribeRef.current = null
			}
			if (mcpServersSubscriptionRef.current) {
				mcpServersSubscriptionRef.current()
				mcpServersSubscriptionRef.current = null
			}
		}
	}, [])

	const contextValue: ExtensionStateContextType = {
		...state,
		didHydrateState,
		showWelcome,
		providerModelsByProvider,
		latestModelRequestIdByProvider,
		mcpServers,
		totalTasksSize,
		availableTerminalProfiles,
		showMcp,
		mcpTab,
		showSettings,
		settingsTargetSection,
		settingsInitialModelTab,
		showHistory,
		globalClineRulesToggles: state.globalClineRulesToggles || {},
		localClineRulesToggles: state.localClineRulesToggles || {},
		localCursorRulesToggles: state.localCursorRulesToggles || {},
		localWindsurfRulesToggles: state.localWindsurfRulesToggles || {},
		localAgentsRulesToggles: state.localAgentsRulesToggles || {},
		localCopilotRulesToggles: state.localCopilotRulesToggles || {},
		localWorkflowToggles: state.localWorkflowToggles || {},
		globalWorkflowToggles: state.globalWorkflowToggles || {},
		enableCheckpointsSetting: state.enableCheckpointsSetting,

		// Navigation functions
		navigateToMcp,
		navigateToSettings,
		navigateToSettingsModelPicker,
		navigateToHistory,
		navigateToChat,

		// Hide functions
		hideSettings,
		hideHistory,
		setShowWelcome,
		startProviderModelsRequest,
		applyProviderModelsResponse,
		setMcpServers,
		setShowMcp,
		closeMcpView,
		setGlobalClineRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				globalClineRulesToggles: toggles,
			})),
		setLocalClineRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localClineRulesToggles: toggles,
			})),
		setLocalCursorRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localCursorRulesToggles: toggles,
			})),
		setLocalWindsurfRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localWindsurfRulesToggles: toggles,
			})),
		setLocalAgentsRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localAgentsRulesToggles: toggles,
			})),
		setLocalCopilotRulesToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localCopilotRulesToggles: toggles,
			})),
		setLocalWorkflowToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localWorkflowToggles: toggles,
			})),
		setGlobalWorkflowToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				globalWorkflowToggles: toggles,
			})),
		setGlobalSkillsToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				globalSkillsToggles: toggles,
			})),
		setLocalSkillsToggles: (toggles) =>
			setState((prevState) => ({
				...prevState,
				localSkillsToggles: toggles,
			})),
		setMcpTab,
		setTotalTasksSize,
		onRelinquishControl,
		expandTaskHeader,
		setExpandTaskHeader,
	}

	return <ExtensionStateContext.Provider value={contextValue}>{children}</ExtensionStateContext.Provider>
}

export const useExtensionState = () => {
	const context = useContext(ExtensionStateContext)
	if (context === undefined) {
		throw new Error("useExtensionState must be used within an ExtensionStateContextProvider")
	}
	return context
}
