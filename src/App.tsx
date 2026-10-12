import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { TopAppBar, BottomNavBar } from './components/Navigation';
import { AuthModal } from './components/AuthModal';
import { UploadZone, type ExtractedUpload } from './components/UploadZone';
import { StatusPanel } from './components/StatusPanel';
import { ConceptCard } from './components/ConceptCard';
import { HeroScreen } from './components/HeroScreen';
import { GraphScreen } from './components/GraphScreen';
import { DetailsScreen } from './components/DetailsScreen';
import { HistoryScreen } from './components/HistoryScreen';
import { DocumentScreen } from './components/DocumentScreen';
import { SearchScreen, type SearchMode } from './components/SearchScreen';
import { AskCitation, AskTurn, Concept, ConceptCategory, DocumentResult, GraphData, SavedGraph, SearchHit, SourceFocus, UploadStatus, User } from './types';
import { ApiError, apiFetch, exportDocument, fetchCurrentUser, setToken, toGraphData } from './lib/api';

export type Screen = 'hero' | 'upload' | 'document' | 'graph' | 'details' | 'history' | 'search';

const LAST_GRAPH_KEY = 'glyph_last_graph';
const LAST_DOCS_KEY = 'glyph_last_docs';

const CATEGORY_BY_TYPE: Record<string, ConceptCategory> = {
  major: 'Core Concept',
  header: 'Main Topic',
  'sub-topic': 'Sub-topic',
  concept: 'Key Detail',
};

function loadLastGraph(): GraphData | null {
  try {
    const raw = sessionStorage.getItem(LAST_GRAPH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadLastDocs(): DocumentResult[] {
  try {
    const raw = sessionStorage.getItem(LAST_DOCS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('hero');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [graphData, setGraphData] = useState<GraphData | null>(loadLastGraph);
  const [viewedNodeIds, setViewedNodeIds] = useState<Set<string>>(new Set());
  // Document intelligence: documents of this session, the open one, and the selected field.
  const [recentDocs, setRecentDocs] = useState<DocumentResult[]>(loadLastDocs);
  const [currentDocId, setCurrentDocId] = useState<string | null>(() => loadLastDocs()[0]?.id ?? null);
  const [selectedFieldKey, setSelectedFieldKey] = useState<string | null>(null);
  // A cited passage (not a field) to show on its page.
  const [sourceFocus, setSourceFocus] = useState<SourceFocus | null>(null);
  // Search screen: plain search or questions to the documents (kept while navigating).
  const [searchMode, setSearchMode] = useState<SearchMode>('search');
  const [askTurns, setAskTurns] = useState<AskTurn[]>([]);
  const [askScope, setAskScope] = useState('');
  // Original files of this session, so a concept map can be built without signing in.
  const uploadedFiles = useRef(new Map<string, File>());
  const currentDoc = recentDocs.find(d => d.id === currentDocId) || null;

  // Scroll to top on screen change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [currentScreen]);

  // Restore the signed-in user from the saved token
  useEffect(() => {
    fetchCurrentUser().then(u => u && setUser(u));
  }, []);

  // Keep the current map across page reloads (per browser tab)
  useEffect(() => {
    try {
      if (graphData) sessionStorage.setItem(LAST_GRAPH_KEY, JSON.stringify(graphData));
    } catch {
      /* storage full or unavailable */
    }
  }, [graphData]);

  useEffect(() => {
    try {
      sessionStorage.setItem(LAST_DOCS_KEY, JSON.stringify(recentDocs.slice(0, 10)));
    } catch {
      /* storage full or unavailable */
    }
  }, [recentDocs]);

  const concepts: Concept[] = useMemo(() => {
    if (!graphData) return [];
    const order = ['major', 'header', 'sub-topic', 'concept'];
    return [...graphData.nodes]
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || (b.importance || 0) - (a.importance || 0))
      .slice(0, 12)
      .map(n => ({
        id: n.id,
        title: n.label,
        description: n.desc || 'Concept extracted from your document.',
        category: CATEGORY_BY_TYPE[n.type] || 'Key Detail',
        tags: [graphData.metadata.category || 'General'].filter(Boolean),
      }));
  }, [graphData]);

  const showGraph = (item: SavedGraph) => {
    setGraphData(toGraphData(item));
    setViewedNodeIds(new Set());
    setCurrentScreen('graph');
  };

  const showDocument = (doc: DocumentResult, fieldKey: string | null = null, focus: SourceFocus | null = null) => {
    setRecentDocs(prev => [doc, ...prev.filter(d => d.id !== doc.id)].slice(0, 10));
    setCurrentDocId(doc.id);
    setSelectedFieldKey(fieldKey);
    setSourceFocus(fieldKey ? null : focus);
    setCurrentScreen('document');
  };

  const onDocumentsReady = (results: ExtractedUpload[], open: boolean) => {
    for (const r of results) uploadedFiles.current.set(r.doc.id, r.file);
    const docs = results.map(r => r.doc);
    // The batch first (last uploaded on top), then earlier documents.
    setRecentDocs(prev => [...[...docs].reverse(), ...prev.filter(d => !docs.some(n => n.id === d.id))].slice(0, 10));
    setCurrentDocId(docs[docs.length - 1].id);
    setSelectedFieldKey(null);
    if (open) setCurrentScreen('document');
  };

  const openDocumentById = async (id: string, fieldKey: string | null = null, focus: SourceFocus | null = null) => {
    const doc = await apiFetch<DocumentResult>(`/documents/${encodeURIComponent(id)}`);
    showDocument(doc, fieldKey, focus);
  };

  const openSearchHit = (hit: SearchHit) =>
    openDocumentById(
      hit.documentId,
      hit.kind === 'field' || hit.kind === 'issue' ? hit.fieldKey || null : null,
      hit.kind === 'text' || hit.kind === 'entity' ? { page: hit.page, quote: hit.sourceQuote || hit.snippet.replace(/^…|…$/g, ''), label: hit.label } : null,
    );

  const openCitation = (c: AskCitation) =>
    openDocumentById(c.documentId, c.kind === 'field' ? c.fieldKey || null : null, c.kind === 'text' ? { page: c.page, quote: c.quote, label: `Cited passage · page ${c.page}` } : null);

  /** Ask questions about the open document. */
  const askAboutDocument = () => {
    if (currentDoc) setAskScope(currentDoc.id);
    setSearchMode('ask');
    setCurrentScreen('search');
  };

  const handleExport = async (format: 'json' | 'csv') => {
    if (!currentDoc) return;
    try {
      await exportDocument(currentDoc, format, true);
    } catch (err) {
      // Not saved for this account or guest workspace: export what is on screen.
      if (err instanceof ApiError && (err.status === 404 || err.status === 401)) return exportDocument(currentDoc, format, false);
      throw err;
    }
  };

  /** Concept map / roadmap / quiz for the open document. */
  const buildConceptMap = async () => {
    if (!currentDoc) return;
    const done = (data: SavedGraph) => {
      setRecentDocs(prev => prev.map(d => (d.id === currentDoc.id ? { ...d, hasGraph: true } : d)));
      showGraph(data);
    };
    try {
      return done(await apiFetch<SavedGraph>(`/documents/${encodeURIComponent(currentDoc.id)}/concept-map`, { method: 'POST' }));
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 401))) throw err;
    }
    // Not saved for this account or guest workspace: run the original concept-map upload.
    const file = uploadedFiles.current.get(currentDoc.id);
    if (!file) throw new Error('Sign in, or upload the file again, to build a concept map from this document.');
    const form = new FormData();
    form.append('pdf', file);
    done(await apiFetch<SavedGraph>('/upload', { method: 'POST', body: form }));
  };

  const onNodeExplored = (nodeId: string) => {
    setViewedNodeIds(prev => (prev.has(nodeId) ? prev : new Set(prev).add(nodeId)));
  };

  const handleAuth = (authedUser: User) => {
    setUser(authedUser);
    setShowAuthModal(false);
  };

  const handleSignOut = () => {
    setUser(null);
    setToken(null);
    if (currentScreen === 'history') setCurrentScreen('hero');
  };

  const renderScreen = () => {
    switch (currentScreen) {
      case 'hero':
        return <HeroScreen
          onStartJourney={() => setCurrentScreen('upload')}
          onOpenSaved={() => (user ? setCurrentScreen('history') : setShowAuthModal(true))}
          isSignedIn={!!user}
        />;
      case 'graph':
        return <GraphScreen data={graphData} onNodeExplored={onNodeExplored} viewedNodeIds={viewedNodeIds} onUploadClick={() => setCurrentScreen('upload')} />;
      case 'details':
        return <DetailsScreen data={graphData} viewedNodeIds={viewedNodeIds} onNavigate={setCurrentScreen} />;
      case 'history':
        return <HistoryScreen
          onLoadGraph={showGraph}
          onOpenDocument={id => openDocumentById(id)}
          onSearchClick={() => setCurrentScreen('search')}
          user={user}
          onSignInClick={() => setShowAuthModal(true)}
        />;
      case 'document':
        return <DocumentScreen
          doc={currentDoc}
          recentDocs={recentDocs}
          selectedFieldKey={selectedFieldKey}
          onSelectField={key => { setSelectedFieldKey(key); setSourceFocus(null); }}
          onSelectDoc={d => { setCurrentDocId(d.id); setSelectedFieldKey(null); setSourceFocus(null); }}
          onUploadClick={() => setCurrentScreen('upload')}
          onExport={handleExport}
          onBuildConceptMap={buildConceptMap}
          onAsk={askAboutDocument}
          focus={sourceFocus}
          onClearFocus={() => setSourceFocus(null)}
          onOpenDocument={(id, fieldKey) => openDocumentById(id, fieldKey)}
        />;
      case 'search':
        return <SearchScreen
          user={user}
          onSignInClick={() => setShowAuthModal(true)}
          onOpenHit={openSearchHit}
          mode={searchMode}
          onModeChange={setSearchMode}
          askTurns={askTurns}
          setAskTurns={setAskTurns}
          askScope={askScope}
          setAskScope={setAskScope}
          onOpenCitation={openCitation}
        />;
      case 'upload':
      default:
        return (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Left Column: Discovered Concepts */}
            <div className="lg:col-span-7 order-2 lg:order-1">
              <div className="bg-surface-container-low rounded-xl p-6 md:p-8 min-h-[600px] flex flex-col border border-slate-200">
                <div className="flex justify-between items-center mb-10 gap-4">
                  <div>
                    <h3 className="text-2xl font-headline font-bold">Discovered Concepts</h3>
                    <p className="text-[10px] text-on-surface-variant uppercase tracking-[0.2em] mt-1">
                      {graphData ? graphData.filename : 'Waiting for a document'}
                    </p>
                  </div>
                  {currentDoc && (
                    <button
                      onClick={() => setCurrentScreen('document')}
                      className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 rounded-full text-[10px] text-primary font-bold uppercase hover:bg-primary/20 transition-colors shrink-0"
                    >
                      <span className="material-symbols-outlined text-sm">plagiarism</span>
                      Open Results
                    </button>
                  )}
                  {graphData && (
                    <button
                      onClick={() => setCurrentScreen('graph')}
                      className="flex items-center gap-2 px-3 py-1.5 bg-tertiary/10 rounded-full text-[10px] text-tertiary font-bold uppercase hover:bg-tertiary/20 transition-colors shrink-0"
                    >
                      <span className="material-symbols-outlined text-sm">account_tree</span>
                      Open Graph
                    </button>
                  )}
                </div>

                {concepts.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <AnimatePresence mode="popLayout">
                      {concepts.map((concept) => (
                        <ConceptCard key={concept.id} concept={concept} />
                      ))}
                    </AnimatePresence>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center py-16 text-slate-400">
                    <span className="material-symbols-outlined text-6xl mb-4 text-slate-300">hub</span>
                    <p className="font-medium text-slate-500">No concepts yet</p>
                    <p className="text-sm mt-1 max-w-xs">Upload a PDF and the key concepts from it will appear here.</p>
                  </div>
                )}

                {graphData && (
                  <div className="mt-auto pt-8">
                    <p className="text-[10px] font-mono text-primary/60 tracking-widest uppercase">
                      {graphData.nodes.length} concepts · {graphData.edges.length} connections
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Upload Zone */}
            <div className="lg:col-span-5 space-y-8 order-1 lg:order-2">
              <section>
                <motion.h2
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-4xl font-headline font-bold mb-2"
                >
                  Knowledge Extraction
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="text-on-surface-variant leading-relaxed"
                >
                  Upload forms, certificates, invoices or reports — PDFs, scans or photos — and the AI will classify them, extract key fields and flag missing or inconsistent details.
                </motion.p>
                {!user && (
                  <p className="text-xs text-slate-500 mt-3">
                    <button onClick={() => setShowAuthModal(true)} className="text-primary font-bold hover:underline">Sign in</button> to save your documents and maps to History.
                  </p>
                )}
              </section>

              <UploadZone onDocumentsReady={onDocumentsReady} setUploads={setUploads} />

              <AnimatePresence>
                {uploads.length > 0 && (
                  <StatusPanel uploads={uploads} />
                )}
              </AnimatePresence>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen pb-32 overflow-x-clip">
      <TopAppBar
        user={user}
        onSignInClick={() => setShowAuthModal(true)}
        onSignOut={handleSignOut}
        currentScreen={currentScreen}
        onScreenChange={setCurrentScreen}
      />

      <main className="pt-24 px-4 md:px-6 max-w-7xl mx-auto">
        <motion.div
          key={currentScreen}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          {renderScreen()}
        </motion.div>
      </main>

      <BottomNavBar currentScreen={currentScreen} onScreenChange={setCurrentScreen} user={user} />

      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onAuth={handleAuth}
      />

      {/* Decorative Glows */}
      <div className="fixed top-[-10%] right-[-10%] w-[50%] h-[50%] bg-primary/3 blur-[120px] rounded-full -z-10 pointer-events-none"></div>
      <div className="fixed bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-secondary/3 blur-[120px] rounded-full -z-10 pointer-events-none"></div>
    </div>
  );
}
