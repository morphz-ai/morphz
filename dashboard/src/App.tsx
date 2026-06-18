import { useEffect, useRef, useState } from 'react';
import { DataSet } from 'vis-data';
import { Network } from 'vis-network';
import { 
  Network as NetIcon, 
  Activity, 
  Cpu, 
  RefreshCw, 
  User, 
  Bot, 
  Wrench, 
  Settings 
} from 'lucide-react';

interface GraphNode {
  id: string;
  label: string;
  properties: { [key: string]: any };
}

interface GraphEdge {
  id: string;
  from_node: string;
  to_node: string;
  type: string;
}

interface Event {
  id: string;
  timestamp: string;
  actor: string;
  type: string;
  topic: string;
  payload: { [key: string]: any };
}

interface Message {
  Role: string;
  Content: string;
  Name: string;
  ToolCallID: string;
  ToolCalls: any[];
}

export default function App() {
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');
  const [events, setEvents] = useState<Event[]>([]);
  const [contextMsgs, setContextMsgs] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string>('');
  
  const graphRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesDataSetRef = useRef<DataSet<any> | null>(null);
  const edgesDataSetRef = useRef<DataSet<any> | null>(null);
  const animationTimersRef = useRef<number[]>([]);

  // 1. 初始化或重新获取 Graph 拓扑数据
  const fetchGraph = async () => {
    try {
      const resp = await fetch('http://127.0.0.1:8080/api/graph');
      if (!resp.ok) return;
      const data = await resp.json();
      updateGraphData(data.nodes || [], data.edges || []);
    } catch (err) {
      console.error('Failed to fetch graph data:', err);
    }
  };

  const updateGraphData = (nodes: GraphNode[], edges: GraphEdge[]) => {
    if (!nodesDataSetRef.current || !edgesDataSetRef.current) return;

    // 格式化为 vis.js 所需的数据格式
    const formattedNodes = nodes.map(n => {
      const displayName = n.properties?.name || n.id;
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
      label: e.type,
      font: { color: '#94a3b8', size: 10, strokeWidth: 0 }
    }));

    nodesDataSetRef.current.clear();
    edgesDataSetRef.current.clear();
    nodesDataSetRef.current.add(formattedNodes);
    edgesDataSetRef.current.add(formattedEdges);

    if (networkRef.current) {
      networkRef.current.fit({ animation: true });
    }
  };

  // 1.1 语义漫游实时亮灯动效实现
  const handleMemoryWalk = (payload: any) => {
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

    const anchorIds = new Set((payload.anchors || []).map((n: any) => n.id));
    const neighborIds = new Set((payload.neighbor_nodes || []).map((n: any) => n.id));
    const walkedEdgeIds = new Set((payload.walked_edges || []).map((e: any) => e.id));
    
    const transitionPaths = payload.transition_paths || [];
    const transitionIds = new Set(transitionPaths.map((p: any) => p.to));
    const tempEdgeIds: string[] = [];

    // --- 步骤 0: 暗淡全图 (t = 0ms) ---
    const dimNodes = originalNodes.map((n: any) => ({
      id: n.id,
      color: {
        background: '#0f172a',
        border: '#1e293b',
      },
      font: { color: '#475569' },
      size: 14,
    }));
    const dimEdges = originalEdges.map((e: any) => ({
      id: e.id,
      color: { color: 'rgba(30, 41, 59, 0.3)' },
      width: 1,
    }));

    nodesDataSet.update(dimNodes);
    edgesDataSet.update(dimEdges);

    // --- 步骤 1: 聚焦并点亮金黄色锚点 (t = 300ms) ---
    const t1 = window.setTimeout(() => {
      const activeAnchors = originalNodes
        .filter((n: any) => anchorIds.has(n.id))
        .map((n: any) => ({
          id: n.id,
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
        network.focus(firstAnchorId, {
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
        .filter((n: any) => transitionIds.has(n.id))
        .map((n: any) => ({
          id: n.id,
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

      transitionPaths.forEach((path: any, index: number) => {
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
        .filter((e: any) => walkedEdgeIds.has(e.id))
        .map((e: any) => ({
          id: e.id,
          color: { color: '#34d399', opacity: 1 },
          width: 4.5,
        }));
      if (activeEdges.length > 0) {
        edgesDataSet.update(activeEdges);
      }

      const activeNeighbors = originalNodes
        .filter((n: any) => neighborIds.has(n.id))
        .map((n: any) => ({
          id: n.id,
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
      tempEdgeIds.forEach(id => {
        try {
          edgesDataSet.remove(id);
        } catch (_) {}
      });
      nodesDataSet.update(originalNodes);
      edgesDataSet.update(originalEdges);
      network.fit({ animation: true });
    }, 5500);
    animationTimersRef.current.push(t4);
  };

  // 2. 初始化 vis.js Network 力导向图
  useEffect(() => {
    if (!graphRef.current) return;

    const nodesDataSet = new DataSet([]);
    const edgesDataSet = new DataSet([]);
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
  }, []);

  // 3. 建立 WebSocket 通信连接
  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: any;

    const connect = () => {
      setWsStatus('connecting');
      ws = new WebSocket('ws://127.0.0.1:8080/ws');

      ws.onopen = () => {
        setWsStatus('connected');
        console.log('WebSocket connected to Morphz Core');
      };

      ws.onmessage = (eventMsg) => {
        try {
          const data = JSON.parse(eventMsg.data);

          // 处理初始化推送数据
          if (data.type === 'init_graph') {
            updateGraphData(data.nodes || [], data.edges || []);
            return;
          }

          // 解析出事件实体
          const ev: Event = data;
          
          // 如果是 L3 Context 监视数据事件
          if (ev.topic === 'chat/context_inspect') {
            const msgs = ev.payload?.messages || [];
            setContextMsgs(msgs);
            const sess = ev.payload?.session_id || '';
            setSessionId(sess);
          }

          // 如果是语义漫游事件
          if (ev.topic === 'chat/memory_walk') {
            handleMemoryWalk(ev.payload);
          }

          // 将事件推入列表
          setEvents((prev) => [ev, ...prev].slice(0, 100));

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
      if (ws) ws.close();
      clearTimeout(reconnectTimer);
    };
  }, []);

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
            MORPHZ <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-white/10 text-white">CORE CANVAS</span>
          </h1>
        </div>

        <div className="flex items-center gap-6">
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
        <section className="lg:col-span-7 flex flex-col glass-panel rounded-2xl overflow-hidden shadow-2xl relative">
          <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between bg-white/2">
            <div className="flex items-center gap-2">
              <NetIcon className="h-5 w-5 text-blue-400" />
              <h2 className="text-sm font-semibold tracking-wide text-gray-200">
                L2 长期记忆关联网络 (Graph Memory)
              </h2>
            </div>
            <span className="text-xs text-gray-400">双击节点可高亮展示，支持拖拽力学缩放</span>
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
        <section className="lg:col-span-5 flex flex-col gap-6 overflow-y-auto">
          {/* L3 Context 推理上下文监视 */}
          <div className="glass-panel rounded-2xl flex flex-col max-h-[350px] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between bg-white/2">
              <div className="flex items-center gap-2">
                <Cpu className="h-5 w-5 text-indigo-400" />
                <h2 className="text-sm font-semibold tracking-wide text-gray-200">
                  L3 Context 视口监视器 (LLM Inspector)
                </h2>
              </div>
              {sessionId && <span className="text-[10px] text-gray-400 font-mono">SESS: {sessionId}</span>}
            </div>

            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
              {contextMsgs.length === 0 ? (
                <div className="h-32 flex flex-col items-center justify-center text-xs text-gray-500">
                  <span>等待大模型触发推理...</span>
                  <span className="text-[10px] text-gray-600 mt-1">在终端对话后，完整的 Prompt 上下文会显示在此处</span>
                </div>
              ) : (
                contextMsgs.map((msg, index) => {
                  const isSystem = msg.Role === 'system';
                  const isUser = msg.Role === 'user';
                  const isAssistant = msg.Role === 'assistant';
                  const isTool = msg.Role === 'tool';
                  
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
                          <span>{msg.Role}</span>
                        </div>
                        {msg.Name && <span className="font-mono">({msg.Name})</span>}
                      </div>
                      <div className="whitespace-pre-wrap leading-relaxed mt-1 font-mono text-[11px]">
                        {msg.Content}
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
