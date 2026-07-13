import { useCallback, useEffect, useRef, useState } from 'react';
import { DataSet } from 'vis-data';
import { Network } from 'vis-network';
import type { Edge as VisEdge, Node as VisNode } from 'vis-network';
import { 
  Network as NetIcon, 
  Activity, 
  Cpu, 
  RefreshCw, 
  User, 
  Bot, 
  Wrench, 
  Settings,
  Plus,
  Send,
  Square,
  Archive,
  MessageSquare,
  Pencil,
  RotateCcw,
} from 'lucide-react';

const CORE_HTTP_URL = import.meta.env.VITE_MORPHZ_HTTP_URL ?? 'http://127.0.0.1:8080';
const CORE_WS_URL = import.meta.env.VITE_MORPHZ_WS_URL ?? 'ws://127.0.0.1:8080/ws';
const CORE_TOKEN = import.meta.env.VITE_MORPHZ_TOKEN as string | undefined;

interface GraphNode {
  id: string;
  label: string;
  properties: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  from_node: string;
  to_node: string;
  edge_type: string;
}

interface TransitionPath {
  from: string;
  to: string;
}

interface Message {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

interface ContextFrame {
  id: string;
  body: string;
  sources: string[];
  revision: number;
  created_version: number;
  updated_version: number;
}

interface MindState {
  version: number;
  frames: ContextFrame[];
  retired: string[];
  protected: string[];
}

interface ContextObservation {
  id: string;
  kind: string;
  topic: string;
  actor: string;
  timestamp: string;
  preview: string;
  truncated: boolean;
  protected: boolean;
  tool_name?: string;
}

interface ContextPressure {
  level: 'normal' | 'notice' | 'warning' | 'critical';
  estimated_tokens: number;
  soft_limit: number;
  hard_limit: number;
  maintenance_reserve: number;
  active_frames: number;
  active_observations: number;
}

interface TurnBudget {
  attempt: number;
  checkpoint_interval: number;
  next_checkpoint_at: number;
  attempts_until_checkpoint: number;
  checkpoint_due: boolean;
  context_transactions_used: number;
  context_transactions_limit: number;
  context_tx_available: boolean;
  phase: 'work' | 'soft-checkpoint';
}

interface WakeSignal {
  cause: 'session-start' | 'user-message' | 'tool-output' | 'context-transaction-result';
  event_id?: string;
  tool_name?: string;
  visible_in_inbox: boolean;
}

interface ReadySessionEvaluation {
  session_id: string;
  parent_session_id?: string;
  turn_budget: TurnBudget;
  wake: WakeSignal;
}

interface EventPayload {
  text?: string;
  messages?: Message[];
  session_id?: string;
  anchors?: GraphNode[];
  neighbor_nodes?: GraphNode[];
  walked_edges?: GraphEdge[];
  transition_paths?: TransitionPath[];
  mind?: MindState;
  inbox?: ContextObservation[];
  pressure?: ContextPressure;
  turn_budget?: TurnBudget;
  wake?: WakeSignal;
  [key: string]: unknown;
}

interface MorphzEvent {
  id: string;
  timestamp: string;
  actor: string;
  type: string;
  topic: string;
  payload: EventPayload;
}

interface SessionRecord {
  id: string;
  agent_id: string;
  context_id: string;
  parent_session_id?: string;
  title: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  last_activity_at: string;
}

interface AgentRecord {
  id: string;
  title: string;
  status: 'active' | 'archived';
  root_context_id: string;
  created_at: string;
  updated_at: string;
}

interface CognitiveContextRecord {
  id: string;
  agent_id: string;
  title: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

interface DelegationRecord {
  id: string;
  parent_session_id: string;
  child_session_id: string;
  task: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
}

interface ContextViewResponse {
  context_id: string;
  active_session_id: string;
  session_id: string;
  ready_sessions: ReadySessionEvaluation[];
  state: MindState;
  observations: ContextObservation[];
  pressure: ContextPressure;
  turn_budget: TurnBudget;
  wake: WakeSignal;
}

export default function App() {
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');
  const [events, setEvents] = useState<MorphzEvent[]>([]);
  const [contextMsgs, setContextMsgs] = useState<Message[]>([]);
  const [mind, setMind] = useState<MindState | null>(null);
  const [inbox, setInbox] = useState<ContextObservation[]>([]);
  const [pressure, setPressure] = useState<ContextPressure | null>(null);
  const [turnBudget, setTurnBudget] = useState<TurnBudget | null>(null);
  const [wake, setWake] = useState<WakeSignal | null>(null);
  const [readySessions, setReadySessions] = useState<ReadySessionEvaluation[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [contexts, setContexts] = useState<CognitiveContextRecord[]>([]);
  const [delegations, setDelegations] = useState<DelegationRecord[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedContextId, setSelectedContextId] = useState<string>('');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const [sessionError, setSessionError] = useState('');
  
  const graphRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesDataSetRef = useRef<DataSet<VisNode> | null>(null);
  const edgesDataSetRef = useRef<DataSet<VisEdge> | null>(null);
  const animationTimersRef = useRef<number[]>([]);

  const updateGraphData = useCallback((nodes: GraphNode[], edges: GraphEdge[]) => {
    if (!nodesDataSetRef.current || !edgesDataSetRef.current) return;

    // 格式化为 vis.js 所需的数据格式
    const formattedNodes = nodes.map(n => {
      const displayName = typeof n.properties?.name === 'string' ? n.properties.name : n.id;
      return {
        id: n.id,
        label: displayName,
        title: `ID: ${n.id}\nLabel: ${n.label}\n属性: ${JSON.stringify(n.properties)}`,
        // 样式微调
        color: {
          background: n.id === 'shafreeck' ? '#1e3a8a' : '#1e293b',
          border: n.id === 'shafreeck' ? '#3b82f6' : '#475569',
        }
      };
    });

    const formattedEdges = edges.map(e => ({
      id: e.id,
      from: e.from_node,
      to: e.to_node,
      label: e.edge_type,
      font: { color: '#94a3b8', size: 10, strokeWidth: 0 }
    }));

    nodesDataSetRef.current.clear();
    edgesDataSetRef.current.clear();
    nodesDataSetRef.current.add(formattedNodes);
    edgesDataSetRef.current.add(formattedEdges);

    if (networkRef.current) {
      networkRef.current.fit({ animation: true });
    }
  }, []);

  // 1. 初始化或重新获取 Graph 拓扑数据
  const fetchGraph = useCallback(async () => {
    try {
      const headers = CORE_TOKEN ? { Authorization: `Bearer ${CORE_TOKEN}` } : undefined;
      const resp = await fetch(`${CORE_HTTP_URL}/api/graph`, { headers });
      if (!resp.ok) return;
      const data = await resp.json() as { nodes?: GraphNode[]; edges?: GraphEdge[] };
      updateGraphData(data.nodes ?? [], data.edges ?? []);
    } catch (err) {
      console.error('Failed to fetch graph data:', err);
    }
  }, [updateGraphData]);

  const apiHeaders = useCallback((jsonBody = false) => {
    const headers: Record<string, string> = {};
    if (CORE_TOKEN) headers.Authorization = `Bearer ${CORE_TOKEN}`;
    if (jsonBody) headers['Content-Type'] = 'application/json';
    return headers;
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/sessions?include_archived=true`, { headers: apiHeaders() });
      if (!resp.ok) throw new Error(`Session list HTTP ${resp.status}`);
      const data = await resp.json() as { sessions?: SessionRecord[] };
      const next = data.sessions ?? [];
      setSessions(next);
      setSelectedContextId(current => {
        if (current && next.some(session => session.context_id === current)) return current;
        return next[0]?.context_id ?? current;
      });
      setSelectedSessionId(current => {
        if (current && next.some(session => session.id === current)) return current;
        const firstContextId = next[0]?.context_id;
        return next.find(session => session.context_id === firstContextId)?.id ?? '';
      });
      setSessionError('');
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders]);

  const fetchAgents = useCallback(async () => {
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/agents?include_archived=true`, { headers: apiHeaders() });
      if (!resp.ok) throw new Error(`Agent list HTTP ${resp.status}`);
      const data = await resp.json() as { agents?: AgentRecord[] };
      const next = data.agents ?? [];
      setAgents(next);
      setSelectedAgentId(current => current && next.some(agent => agent.id === current) ? current : next[0]?.id ?? '');
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders]);

  const fetchDelegations = useCallback(async () => {
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/delegations`, { headers: apiHeaders() });
      if (!resp.ok) throw new Error(`Delegation list HTTP ${resp.status}`);
      const data = await resp.json() as { delegations?: DelegationRecord[] };
      setDelegations(data.delegations ?? []);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders]);

  const fetchContexts = useCallback(async () => {
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/contexts?include_archived=true`, { headers: apiHeaders() });
      if (!resp.ok) throw new Error(`Context list HTTP ${resp.status}`);
      const data = await resp.json() as { contexts?: CognitiveContextRecord[] };
      const next = data.contexts ?? [];
      setContexts(next);
      setSelectedContextId(current => {
        if (current && next.some(context => context.id === current)) return current;
        return next[0]?.id ?? '';
      });
      setSessionError('');
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders]);

  const createContext = useCallback(async () => {
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/contexts`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({ title: '新认知 Context', agent_id: selectedAgentId || undefined }),
      });
      if (!resp.ok) throw new Error(`Create Context HTTP ${resp.status}`);
      const context = await resp.json() as CognitiveContextRecord;
      await fetchContexts();
      setSelectedContextId(context.id);
      setSelectedSessionId('');
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders, fetchContexts, selectedAgentId]);

  const createAgent = useCallback(async () => {
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/agents`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({ title: '新 Agent', root_context_title: 'Root Context', initial_session_title: '初始会话' }),
      });
      if (!resp.ok) throw new Error(`Create Agent HTTP ${resp.status}`);
      const bundle = await resp.json() as { agent: AgentRecord; root_context: CognitiveContextRecord; initial_session: SessionRecord };
      await Promise.all([fetchAgents(), fetchContexts(), fetchSessions()]);
      setSelectedAgentId(bundle.agent.id);
      setSelectedContextId(bundle.root_context.id);
      setSelectedSessionId(bundle.initial_session.id);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders, fetchAgents, fetchContexts, fetchSessions]);

  const fetchSessionSnapshot = useCallback(async (sessionId: string) => {
    if (!sessionId) return;
    try {
      const [eventsResp, contextResp] = await Promise.all([
        fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(sessionId)}/events?limit=100`, { headers: apiHeaders() }),
        fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(sessionId)}/context`, { headers: apiHeaders() }),
      ]);
      if (eventsResp.ok) {
        const data = await eventsResp.json() as { events?: MorphzEvent[] };
        setEvents([...(data.events ?? [])].reverse());
      }
      if (contextResp.ok) {
        const context = await contextResp.json() as ContextViewResponse;
        setMind(context.state);
        setInbox(context.observations);
        setPressure(context.pressure);
        setTurnBudget(context.turn_budget);
        setWake(context.wake);
        setReadySessions(context.ready_sessions ?? []);
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders]);

  const createSession = useCallback(async () => {
    if (!selectedContextId) return;
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/sessions`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({ title: '新会话', context_id: selectedContextId }),
      });
      if (!resp.ok) throw new Error(`Create Session HTTP ${resp.status}`);
      const session = await resp.json() as SessionRecord;
      await fetchSessions();
      setSelectedSessionId(session.id);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders, fetchSessions, selectedContextId]);

  const createIndependentSession = useCallback(async () => {
    if (!selectedContextId) return;
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/sessions/independent`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          source_context_id: selectedContextId,
          context_title: '继承 Mind 的独立 Context',
          session_title: '独立会话',
        }),
      });
      if (!resp.ok) throw new Error(`Create independent Session HTTP ${resp.status}`);
      const result = await resp.json() as { context: CognitiveContextRecord; session: SessionRecord };
      await Promise.all([fetchContexts(), fetchSessions()]);
      setSelectedAgentId(result.context.agent_id);
      setSelectedContextId(result.context.id);
      setSelectedSessionId(result.session.id);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders, fetchContexts, fetchSessions, selectedContextId]);

  const sendMessage = useCallback(async () => {
    const text = messageText.trim();
    if (!selectedSessionId || !text || sending) return;
    setSending(true);
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(selectedSessionId)}/messages`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          text,
          client_message_id: `dashboard-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        }),
      });
      if (!resp.ok) throw new Error(`Send Message HTTP ${resp.status}`);
      setMessageText('');
      setSessionError('');
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }, [apiHeaders, messageText, selectedSessionId, sending]);

  const cancelSession = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(selectedSessionId)}/cancel`, {
        method: 'POST',
        headers: apiHeaders(),
      });
      if (!resp.ok) throw new Error(`Cancel Session HTTP ${resp.status}`);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders, selectedSessionId]);

  const updateSession = useCallback(async (update: { title?: string; status?: 'active' | 'archived' }) => {
    if (!selectedSessionId) return;
    try {
      const resp = await fetch(`${CORE_HTTP_URL}/api/sessions/${encodeURIComponent(selectedSessionId)}`, {
        method: 'PATCH',
        headers: apiHeaders(true),
        body: JSON.stringify(update),
      });
      if (!resp.ok) throw new Error(`Update Session HTTP ${resp.status}`);
      await fetchSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  }, [apiHeaders, fetchSessions, selectedSessionId]);

  const renameSession = useCallback(() => {
    const session = sessions.find(item => item.id === selectedSessionId);
    if (!session) return;
    const title = window.prompt('新的 Session 名称', session.title)?.trim();
    if (title) void updateSession({ title });
  }, [selectedSessionId, sessions, updateSession]);

  const selectedSession = sessions.find(session => session.id === selectedSessionId);
  const agentContexts = contexts.filter(context => !selectedAgentId || context.agent_id === selectedAgentId);
  const contextSessions = sessions.filter(session => session.context_id === selectedContextId);
  const sessionDelegations = delegations.filter(delegation => delegation.parent_session_id === selectedSessionId);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchSessions();
      void fetchContexts();
      void fetchAgents();
      void fetchDelegations();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchAgents, fetchContexts, fetchDelegations, fetchSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const timer = window.setTimeout(() => {
      void fetchSessionSnapshot(selectedSessionId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchSessionSnapshot, selectedSessionId]);

  // 1.1 语义漫游实时亮灯动效实现
  const handleMemoryWalk = useCallback((payload: EventPayload) => {
    if (!nodesDataSetRef.current || !edgesDataSetRef.current || !networkRef.current) return;
    console.log('💡 [Memory Walk Path] 漫游足迹详情:', payload);

    // 1) 清理之前的未完动画定时器，防抖防并发
    animationTimersRef.current.forEach(timer => clearTimeout(timer));
    animationTimersRef.current = [];

    const nodesDataSet = nodesDataSetRef.current;
    const edgesDataSet = edgesDataSetRef.current;
    const network = networkRef.current;

    // 2) 备份原始节点和边，作为最终还原快照
    const originalNodes = nodesDataSet.get();
    const originalEdges = edgesDataSet.get();

    const anchorIds = new Set((payload.anchors ?? []).map(node => node.id));
    const neighborIds = new Set((payload.neighbor_nodes ?? []).map(node => node.id));
    const walkedEdgeIds = new Set((payload.walked_edges ?? []).map(edge => edge.id));
    
    const transitionPaths = payload.transition_paths ?? [];
    const transitionIds = new Set(transitionPaths.map(path => path.to));
    const tempEdgeIds: string[] = [];

    // --- 步骤 0: 暗淡全图 (t = 0ms) ---
    const dimNodes = originalNodes.map(node => ({
      id: node.id,
      color: {
        background: '#0f172a',
        border: '#1e293b',
      },
      font: { color: '#475569' },
      size: 14,
    }));
    const dimEdges = originalEdges.map(edge => ({
      id: edge.id,
      color: { color: 'rgba(30, 41, 59, 0.3)' },
      width: 1,
    }));

    nodesDataSet.update(dimNodes);
    edgesDataSet.update(dimEdges);

    // --- 步骤 1: 聚焦并点亮金黄色锚点 (t = 300ms) ---
    const t1 = window.setTimeout(() => {
      const activeAnchors = originalNodes
        .filter(node => node.id !== undefined && anchorIds.has(String(node.id)))
        .map(node => ({
          id: node.id,
          color: {
            background: '#fbbf24',
            border: '#d97706',
            highlight: { background: '#fbbf24', border: '#f59e0b' }
          },
          font: { color: '#fbbf24', size: 16 },
          size: 32,
        }));
      if (activeAnchors.length > 0) {
        nodesDataSet.update(activeAnchors);
        // 平滑聚焦首个锚点
        const firstAnchorId = activeAnchors[0].id;
        if (firstAnchorId !== undefined) network.focus(firstAnchorId, {
          scale: 1.2,
          animation: {
            duration: 1000,
            easingFunction: 'easeInOutQuad',
          },
        });
      }
    }, 300);
    animationTimersRef.current.push(t1);

    // --- 步骤 2: 点亮类比激活跃迁点，并临时绘制紫色虚线连接 (t = 1500ms) ---
    const t2 = window.setTimeout(() => {
      const activeTransitions = originalNodes
        .filter(node => node.id !== undefined && transitionIds.has(String(node.id)))
        .map(node => ({
          id: node.id,
          color: {
            background: '#c084fc',
            border: '#7c3aed',
            highlight: { background: '#c084fc', border: '#8b5cf6' }
          },
          font: { color: '#c084fc', size: 16 },
          size: 30,
        }));
      if (activeTransitions.length > 0) {
        nodesDataSet.update(activeTransitions);
      }

      transitionPaths.forEach((path, index) => {
        if (nodesDataSet.get(path.from) && nodesDataSet.get(path.to)) {
          const tempEdgeId = `temp-trans-${path.from}-${path.to}-${index}`;
          tempEdgeIds.push(tempEdgeId);
          edgesDataSet.add({
            id: tempEdgeId,
            from: path.from,
            to: path.to,
            label: '空间跃迁',
            font: { color: '#c084fc', size: 9, strokeWidth: 0 },
            color: { color: '#c084fc', opacity: 0.8 },
            width: 2.5,
            dashes: true,
            arrows: { to: { enabled: true, scaleFactor: 0.5 } },
          });
        }
      });
    }, 1500);
    animationTimersRef.current.push(t2);

    // --- 步骤 3: 拓扑扩散，高亮亮绿色的边与翡翠绿的一跳邻节点 (t = 2700ms) ---
    const t3 = window.setTimeout(() => {
      const activeEdges = originalEdges
        .filter(edge => edge.id !== undefined && walkedEdgeIds.has(String(edge.id)))
        .map(edge => ({
          id: edge.id,
          color: { color: '#34d399', opacity: 1 },
          width: 4.5,
        }));
      if (activeEdges.length > 0) {
        edgesDataSet.update(activeEdges);
      }

      const activeNeighbors = originalNodes
        .filter(node => node.id !== undefined && neighborIds.has(String(node.id)))
        .map(node => ({
          id: node.id,
          color: {
            background: '#34d399',
            border: '#059669',
            highlight: { background: '#34d399', border: '#10b981' }
          },
          font: { color: '#34d399', size: 14 },
          size: 24,
        }));
      if (activeNeighbors.length > 0) {
        nodesDataSet.update(activeNeighbors);
      }
    }, 2700);
    animationTimersRef.current.push(t3);

    // --- 步骤 4: 渐进式淡出复原并清理临时虚线边 (t = 5500ms) ---
    const t4 = window.setTimeout(() => {
      tempEdgeIds.forEach(id => edgesDataSet.remove(id));
      nodesDataSet.update(originalNodes);
      edgesDataSet.update(originalEdges);
      network.fit({ animation: true });
    }, 5500);
    animationTimersRef.current.push(t4);
  }, []);

  // 2. 初始化 vis.js Network 力导向图
  useEffect(() => {
    if (!graphRef.current) return;

    const nodesDataSet = new DataSet<VisNode>([]);
    const edgesDataSet = new DataSet<VisEdge>([]);
    nodesDataSetRef.current = nodesDataSet;
    edgesDataSetRef.current = edgesDataSet;

    const options = {
      physics: {
        stabilization: false,
        barnesHut: {
          gravitationalConstant: -10000,
          centralGravity: 0.3,
          springLength: 180,
          springConstant: 0.04,
          damping: 0.09,
          avoidOverlap: 1
        }
      },
      nodes: {
        shape: 'dot',
        size: 20,
        font: { 
          color: '#ffffff', 
          size: 14, 
          face: 'Inter, system-ui',
          strokeWidth: 2,
          strokeColor: '#0b0f19'
        },
        borderWidth: 2,
        shadow: true,
        color: {
          background: '#1e293b',
          border: '#3b82f6',
          highlight: {
            background: '#3b82f6',
            border: '#60a5fa'
          }
        }
      },
      edges: {
        color: 'rgba(71, 85, 105, 0.6)',
        width: 2,
        hoverWidth: 3,
        selectionWidth: 3,
        arrows: {
          to: {
            enabled: true,
            scaleFactor: 0.5
          }
        },
        shadow: true
      },
      interaction: {
        hover: true,
        tooltipDelay: 100
      }
    };

    const network = new Network(graphRef.current, { nodes: nodesDataSet, edges: edgesDataSet }, options);
    networkRef.current = network;

    fetchGraph();

    return () => {
      network.destroy();
    };
  }, [fetchGraph]);

  // 3. 建立 WebSocket 通信连接
  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setWsStatus('connecting');
      const params = new URLSearchParams();
      if (CORE_TOKEN) params.set('token', CORE_TOKEN);
      if (selectedSessionId) params.set('session_id', selectedSessionId);
      const query = params.toString();
      const wsUrl = query ? `${CORE_WS_URL}?${query}` : CORE_WS_URL;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setWsStatus('connected');
        console.log('WebSocket connected to Morphz Core');
      };

      ws.onmessage = (eventMsg) => {
        try {
          const data = JSON.parse(eventMsg.data) as MorphzEvent | {
            type: 'init_graph';
            nodes?: GraphNode[];
            edges?: GraphEdge[];
          };

          // 处理初始化推送数据
          if (data.type === 'init_graph' && 'nodes' in data) {
            updateGraphData(data.nodes ?? [], data.edges ?? []);
            return;
          }

          // 解析出事件实体
          const ev = data as MorphzEvent;
          
          // 如果是 L3 Context 监视数据事件
          if (ev.topic === 'chat/context_inspect') {
            const msgs = ev.payload.messages ?? [];
            setContextMsgs(msgs);
            setMind(ev.payload.mind ?? null);
            setInbox(ev.payload.inbox ?? []);
            setPressure(ev.payload.pressure ?? null);
            setTurnBudget(ev.payload.turn_budget ?? null);
            setWake(ev.payload.wake ?? null);
          }

          // 如果是语义漫游事件
          if (ev.topic === 'chat/memory_walk') {
            handleMemoryWalk(ev.payload);
          }

          // 将事件推入列表
          setEvents((prev) => [ev, ...prev].slice(0, 100));

          if (ev.topic === 'chat/reply' || ev.topic === 'chat/cancelled') {
            fetchSessions();
            fetchDelegations();
          }

          // 只要有任何 chat 行为，我们就去增量重新拉取一遍最新的拓扑关系网
          // 排除 memory_walk，因为它不涉及图的任何持久写改动，纯是检索的轨迹高亮
          if (ev.topic.startsWith('chat/') && ev.topic !== 'chat/memory_walk') {
            fetchGraph();
          }

        } catch (err) {
          console.error('WebSocket msg decode error:', err);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setWsStatus('disconnected');
        console.log('WebSocket disconnected, retrying in 3s...');
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        console.error('WebSocket connection error:', err);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (ws) ws.close();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    };
  }, [fetchDelegations, fetchGraph, fetchSessions, handleMemoryWalk, selectedSessionId, updateGraphData]);

  // 格式化时间戳
  const formatTime = (tsStr: string) => {
    try {
      const d = new Date(tsStr);
      return d.toLocaleTimeString();
    } catch {
      return '';
    }
  };

  return (
    <div className="min-h-screen bg-[#070b13] text-gray-100 flex flex-col font-sans antialiased selection:bg-blue-600 selection:text-white">
      {/* 头部导航栏 */}
      <header className="h-16 px-6 glass-panel border-b border-white/5 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <Activity className="h-6 w-6 text-blue-500 animate-pulse" />
          <h1 className="text-xl font-bold tracking-wider bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
            MORPHZ <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-white/10 text-white">MIND INSPECTOR</span>
          </h1>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <select
              value={selectedAgentId}
              onChange={event => {
                const agentId = event.target.value;
                const nextContext = contexts.find(context => context.agent_id === agentId);
                setSelectedAgentId(agentId);
                setSelectedContextId(nextContext?.id ?? '');
                setSelectedSessionId(nextContext ? sessions.find(session => session.context_id === nextContext.id)?.id ?? '' : '');
              }}
              className="max-w-56 rounded-lg border border-emerald-500/20 bg-slate-950 px-3 py-2 text-xs text-emerald-200 outline-none focus:border-emerald-500/50"
              aria-label="选择 Agent"
            >
              {agents.length === 0 && <option value="">暂无 Agent</option>}
              {agents.map(agent => (
                <option key={agent.id} value={agent.id}>
                  {agent.status === 'archived' ? '[已归档] ' : ''}{agent.title} · {agent.id}
                </option>
              ))}
            </select>
            <button
              onClick={createAgent}
              className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 text-emerald-300"
              title="创建全新 Agent、空白 Root Context 与初始 Session"
            >
              <Bot className="h-4 w-4" />
            </button>
            <select
              value={selectedContextId}
              onChange={event => {
                const contextId = event.target.value;
                setSelectedContextId(contextId);
                setSelectedSessionId(sessions.find(session => session.context_id === contextId)?.id ?? '');
              }}
              className="max-w-64 rounded-lg border border-violet-500/20 bg-slate-950 px-3 py-2 text-xs text-violet-200 outline-none focus:border-violet-500/50"
              aria-label="选择 Cognitive Context"
            >
              {agentContexts.length === 0 && <option value="">该 Agent 暂无 Context</option>}
              {agentContexts.map(context => (
                <option key={context.id} value={context.id}>
                  {context.status === 'archived' ? '[已归档] ' : ''}{context.title} · {context.id}
                </option>
              ))}
            </select>
            <button
              onClick={createContext}
              className="p-2 rounded-lg bg-violet-500/10 border border-violet-500/20 hover:bg-violet-500/20 text-violet-300"
              title="创建共享认知 Context"
            >
              <Plus className="h-4 w-4" />
            </button>
            <select
              value={selectedSessionId}
              onChange={event => setSelectedSessionId(event.target.value)}
              className="max-w-64 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs text-slate-200 outline-none focus:border-blue-500/50"
              aria-label="选择 Session"
            >
              {contextSessions.length === 0 && <option value="">当前 Context 暂无会话</option>}
              {contextSessions.map(session => (
                <option key={session.id} value={session.id}>
                  {session.status === 'archived' ? '[已归档] ' : ''}{session.title} · {session.id}
                </option>
              ))}
            </select>
            <button
              onClick={createSession}
              disabled={!selectedContextId}
              className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 text-blue-300"
              title="在当前 Context 中创建新 Session"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              onClick={createIndependentSession}
              disabled={!selectedContextId}
              className="px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20 text-[11px] font-medium text-amber-300 disabled:opacity-40"
              title="继承当前 Mind，但不继承当前 Context 的 Session 与 Inbox"
            >
              独立会话
            </button>
          </div>
          {/* WebSocket 连接状态 */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/5">
            <span className={`h-2 w-2 rounded-full ${
              wsStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
              wsStatus === 'connecting' ? 'bg-amber-500 animate-spin' : 'bg-rose-500'
            }`} />
            <span className="text-xs font-medium text-gray-400 capitalize">
              {wsStatus === 'connected' ? 'Core Online' : wsStatus === 'connecting' ? 'Connecting...' : 'Core Offline'}
            </span>
          </div>

          <button 
            onClick={fetchGraph}
            className="p-2 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 hover:border-white/10 transition-all text-gray-300"
            title="手动更新记忆图谱"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* 主工作区 */}
      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 overflow-hidden">
        {/* 左栏：长期记忆网络拓扑 (vis-network) */}
        <section className="lg:col-span-4 flex flex-col glass-panel rounded-2xl overflow-hidden shadow-2xl relative">
          <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between bg-white/2">
            <div className="flex items-center gap-2">
              <NetIcon className="h-5 w-5 text-blue-400" />
              <h2 className="text-sm font-semibold tracking-wide text-gray-200">
                Recall 索引实验区 (不自动注入 Mind)
              </h2>
            </div>
            <span className="text-xs text-gray-400">仅供观察，不参与 v1 Context 装配</span>
          </div>

          {/* vis.js network container */}
          <div ref={graphRef} className="flex-1 w-full h-[600px] lg:h-auto bg-[#090d16]" />

          {/* 浮动指引面板 */}
          <div className="absolute bottom-4 left-4 p-3 bg-slate-900/90 border border-white/10 rounded-xl flex flex-col gap-1.5 text-xs text-gray-400 backdrop-blur-md">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              <span>蓝色节点：主物理实体 (如 User, Morphz)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-slate-600" />
              <span>灰色节点：被提取沉淀的概念与关联概念</span>
            </div>
          </div>
        </section>

        {/* 右栏：Context 监视与事件瀑布 */}
        <section className="lg:col-span-8 flex flex-col gap-6 overflow-y-auto">
          <div className="glass-panel rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between bg-white/2">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-blue-400" />
                <div>
                  <h2 className="text-sm font-semibold tracking-wide text-gray-200">Session Console</h2>
                  <div className="text-[10px] font-mono text-gray-500">
                    CTX {selectedContextId || '—'} / SESS {selectedSessionId || '请先创建 Session'}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    Delegation：{sessionDelegations.length} · Running：{sessionDelegations.filter(item => item.status === 'running' || item.status === 'queued').length}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={cancelSession}
                  disabled={!selectedSessionId}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 text-[10px] text-amber-300 disabled:opacity-40"
                >
                  <Square className="h-3 w-3" />取消执行
                </button>
                <button
                  onClick={renameSession}
                  disabled={!selectedSessionId}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-500/20 bg-slate-500/10 text-[10px] text-slate-300 disabled:opacity-40"
                >
                  <Pencil className="h-3 w-3" />改名
                </button>
                <button
                  onClick={() => updateSession({ status: selectedSession?.status === 'archived' ? 'active' : 'archived' })}
                  disabled={!selectedSessionId}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-500/20 bg-slate-500/10 text-[10px] text-slate-300 disabled:opacity-40"
                >
                  {selectedSession?.status === 'archived' ? <RotateCcw className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
                  {selectedSession?.status === 'archived' ? '恢复' : '归档'}
                </button>
              </div>
            </div>

            <div className="max-h-72 overflow-y-auto p-4 space-y-2 bg-slate-950/25">
              {events.filter(event => ['chat/user_message', 'chat/progress', 'chat/reply', 'chat/cancelled'].includes(event.topic)).length === 0 ? (
                <div className="py-10 text-center text-xs text-gray-500">这个 Session 还没有对话</div>
              ) : (
                events
                  .filter(event => ['chat/user_message', 'chat/progress', 'chat/reply', 'chat/cancelled'].includes(event.topic))
                  .slice(0, 30)
                  .reverse()
                  .map(event => {
                    const isUser = event.topic === 'chat/user_message';
                    const isProgress = event.topic === 'chat/progress';
                    return (
                      <div key={event.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] rounded-xl border px-3 py-2 text-xs whitespace-pre-wrap ${
                          isUser
                            ? 'border-blue-500/20 bg-blue-500/10 text-blue-100'
                            : isProgress
                              ? 'border-amber-500/15 bg-amber-500/5 text-amber-100'
                              : 'border-violet-500/20 bg-violet-500/10 text-violet-100'
                        }`}>
                          {isProgress && <div className="mb-1 text-[9px] uppercase tracking-wider text-amber-400">执行进度</div>}
                          {event.payload.text ?? ''}
                        </div>
                      </div>
                    );
                  })
              )}
            </div>

            <div className="border-t border-white/5 p-4">
              <div className="flex gap-3">
                <textarea
                  value={messageText}
                  onChange={event => setMessageText(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      sendMessage();
                    }
                  }}
                  disabled={!selectedSessionId || selectedSession?.status === 'archived' || sending}
                  placeholder={selectedSession?.status === 'archived' ? '请先恢复已归档 Session' : '输入消息；Command/Ctrl + Enter 发送'}
                  className="min-h-20 flex-1 resize-y rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-blue-500/40 disabled:opacity-50"
                />
                <button
                  onClick={sendMessage}
                  disabled={!selectedSessionId || selectedSession?.status === 'archived' || !messageText.trim() || sending}
                  className="self-end flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />{sending ? '发送中' : '发送'}
                </button>
              </div>
              {sessionError && <div className="mt-2 text-[10px] text-rose-400">{sessionError}</div>}
            </div>
          </div>

          {/* L3 Context 推理上下文监视 */}
          <div className="glass-panel rounded-2xl flex flex-col max-h-[520px] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between bg-white/2">
              <div className="flex items-center gap-2">
                <Cpu className="h-5 w-5 text-indigo-400" />
                <h2 className="text-sm font-semibold tracking-wide text-gray-200">
                  Agent-Owned Context Inspector
                </h2>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono">
                {mind && <span className="text-indigo-300">V{mind.version}</span>}
                {turnBudget && <span className={turnBudget.checkpoint_due ? 'text-amber-300' : 'text-cyan-300'}>A{turnBudget.attempt}→CP{turnBudget.next_checkpoint_at}:{turnBudget.phase}</span>}
                {turnBudget && <span className={turnBudget.context_tx_available ? 'text-emerald-300' : 'text-slate-400'}>CTX{turnBudget.context_transactions_used}/{turnBudget.context_transactions_limit}</span>}
                {wake && <span className="text-violet-300">WAKE:{wake.cause}{wake.tool_name ? `/${wake.tool_name}` : ''}</span>}
                {readySessions.length > 1 && <span className="text-fuchsia-300">BATCH:{readySessions.length}</span>}
                {pressure && (
                  <span className={`px-2 py-0.5 rounded-full border ${
                    pressure.level === 'critical' ? 'text-rose-300 border-rose-500/30 bg-rose-500/10' :
                    pressure.level === 'warning' ? 'text-amber-300 border-amber-500/30 bg-amber-500/10' :
                    pressure.level === 'notice' ? 'text-blue-300 border-blue-500/30 bg-blue-500/10' :
                    'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
                  }`}>{pressure.level}</span>
                )}
                {selectedSessionId && <span className="text-gray-400">SESS: {selectedSessionId}</span>}
                {selectedContextId && <span className="text-violet-300">CTX: {selectedContextId}</span>}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {pressure && (
                <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
                  <div className="rounded-lg border border-indigo-500/15 bg-indigo-500/5 p-2">
                    <div className="text-gray-500">ACTIVE FRAMES</div>
                    <div className="text-indigo-300 text-sm">{pressure.active_frames}</div>
                  </div>
                  <div className="rounded-lg border border-blue-500/15 bg-blue-500/5 p-2">
                    <div className="text-gray-500">INBOX</div>
                    <div className="text-blue-300 text-sm">{pressure.active_observations}</div>
                  </div>
                  <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-2">
                    <div className="text-gray-500">EST. TOKENS</div>
                    <div className="text-emerald-300 text-sm">{pressure.estimated_tokens.toLocaleString()}</div>
                  </div>
                </div>
              )}

              {mind && mind.frames.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-[10px] uppercase tracking-widest text-gray-500">Agent-Owned Mind Frames</div>
                  {mind.frames
                    .filter(frame => !mind.retired.includes(frame.id))
                    .map(frame => (
                      <div key={frame.id} className="rounded-xl border border-violet-500/20 bg-violet-950/15 p-3">
                        <div className="flex items-center justify-between text-[10px] font-mono mb-2">
                          <span className="text-violet-300">{frame.id}</span>
                          <span className="text-gray-500">
                            r{frame.revision}{mind.protected.includes(frame.id) ? ' · protected' : ''}
                          </span>
                        </div>
                        <div className="whitespace-pre-wrap text-[11px] leading-relaxed font-mono text-violet-100">{frame.body}</div>
                        {frame.sources.length > 0 && (
                          <div className="mt-2 text-[9px] text-gray-500 font-mono break-all">
                            FROM: {frame.sources.join(', ')}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}

              {inbox.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-[10px] uppercase tracking-widest text-gray-500">Unretired Ledger Observations</div>
                  {inbox.slice(-8).map(observation => (
                    <div key={observation.id} className="rounded-xl border border-blue-500/15 bg-blue-950/10 p-3">
                      <div className="flex items-center justify-between gap-2 text-[9px] font-mono mb-1.5">
                        <span className="text-blue-300 truncate">{observation.id}</span>
                        <span className="text-gray-500 shrink-0">{observation.tool_name ?? observation.kind}</span>
                      </div>
                      <div className="whitespace-pre-wrap text-[10px] leading-relaxed font-mono text-blue-100 max-h-20 overflow-y-auto">
                        {observation.preview}
                      </div>
                      {observation.truncated && <div className="text-[9px] text-amber-400 mt-1">preview only · recall full-ref</div>}
                    </div>
                  ))}
                  {inbox.length > 8 && <div className="text-[9px] text-gray-500 text-center">仅展示最近 8 条，共 {inbox.length} 条 active observation</div>}
                </div>
              )}

              <div className="text-[10px] uppercase tracking-widest text-gray-500 mt-1">Compiled Model Messages</div>
              {contextMsgs.length === 0 ? (
                <div className="h-32 flex flex-col items-center justify-center text-xs text-gray-500">
                  <span>等待大模型触发推理...</span>
                  <span className="text-[10px] text-gray-600 mt-1">在终端对话后，完整的 Prompt 上下文会显示在此处</span>
                </div>
              ) : (
                contextMsgs.map((msg, index) => {
                  const isSystem = msg.role === 'system';
                  const isUser = msg.role === 'user';
                  const isAssistant = msg.role === 'assistant';
                  const isTool = msg.role === 'tool';
                  
                  return (
                    <div 
                      key={index} 
                      className={`p-3 rounded-xl border flex flex-col gap-1 text-xs ${
                        isSystem ? 'bg-indigo-950/20 border-indigo-500/20 text-indigo-200' :
                        isUser ? 'bg-blue-950/20 border-blue-500/20 text-blue-200' :
                        isAssistant ? 'bg-violet-950/20 border-violet-500/20 text-violet-200' :
                        'bg-emerald-950/20 border-emerald-500/20 text-emerald-200'
                      }`}
                    >
                      <div className="flex items-center justify-between font-semibold capitalize text-[10px] tracking-wider opacity-85">
                        <div className="flex items-center gap-1.5">
                          {isUser && <User className="h-3 w-3" />}
                          {isAssistant && <Bot className="h-3 w-3" />}
                          {isTool && <Wrench className="h-3 w-3" />}
                          {isSystem && <Settings className="h-3 w-3" />}
                          <span>{msg.role}</span>
                        </div>
                        {msg.name && <span className="font-mono">({msg.name})</span>}
                      </div>
                      <div className="whitespace-pre-wrap leading-relaxed mt-1 font-mono text-[11px]">
                        {msg.content}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* EventBus 实时事件瀑布 */}
          <div className="glass-panel rounded-2xl flex-1 flex flex-col max-h-[350px] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between bg-white/2">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-emerald-400" />
                <h2 className="text-sm font-semibold tracking-wide text-gray-200">
                  EventBus 实时事件瀑布流
                </h2>
              </div>
              <span className="text-[10px] text-gray-500">仅显示最近 100 条事件</span>
            </div>

            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2.5">
              {events.length === 0 ? (
                <div className="h-32 flex items-center justify-center text-xs text-gray-500">
                  等待 EventBus 消息流转...
                </div>
              ) : (
                events.map((ev) => {
                  const isUser = ev.type === 'user_message';
                  const isAgent = ev.type === 'agent_call';
                  const isTool = ev.type === 'tool_output';
                  const isProposal = ev.type === 'proposal';
                  
                  return (
                    <div 
                      key={ev.id} 
                      className={`p-3 rounded-xl border flex flex-col gap-1.5 text-xs transition-all hover:bg-white/2 ${
                        isUser ? 'bg-blue-500/5 border-blue-500/10' :
                        isAgent ? 'bg-violet-500/5 border-violet-500/10' :
                        isTool ? 'bg-emerald-500/5 border-emerald-500/10' :
                        'bg-gray-500/5 border-gray-500/10'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[10px] text-gray-400">
                        <span className="font-mono">{formatTime(ev.timestamp)}</span>
                        <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/5 text-[9px] uppercase tracking-wider font-semibold">
                          {ev.actor}
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="font-bold text-gray-200 text-xs tracking-wide">
                          {ev.topic}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-mono ${
                          isUser ? 'text-blue-400 bg-blue-400/5' :
                          isAgent ? 'text-violet-400 bg-violet-400/5' :
                          isTool ? 'text-emerald-400 bg-emerald-400/5' :
                          isProposal ? 'text-indigo-400 bg-indigo-400/5' : 'text-gray-400 bg-gray-400/5'
                        }`}>
                          {ev.type}
                        </span>
                      </div>

                      {ev.payload?.text && (
                        <div className="text-gray-300 font-mono text-[11px] leading-relaxed bg-black/20 p-2 rounded-lg mt-0.5 border border-white/2 max-h-24 overflow-y-auto">
                          {ev.payload.text}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
