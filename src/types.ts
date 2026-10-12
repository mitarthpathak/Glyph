export type ConceptCategory = 'Core Concept' | 'Main Topic' | 'Sub-topic' | 'Key Detail';

export interface Concept {
  id: string;
  title: string;
  description: string;
  category: ConceptCategory;
  tags: string[];
  isNew?: boolean;
  correlationNote?: string;
}

export interface UploadStatus {
  id: string;
  fileName: string;
  progress: number;
  status: 'uploading' | 'analyzing' | 'completed' | 'failed';
  subtext?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  phone: string;
  age: number | null;
}

export type NodeType = 'major' | 'header' | 'sub-topic' | 'concept';

export interface GraphNode {
  id: string;
  label: string;
  type: NodeType;
  desc?: string;
  importance?: number;
  parentId?: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  importance?: number;
}

export interface RoadmapItem {
  number: string;
  title: string;
  status: 'completed' | 'in-progress' | 'locked' | string;
  desc: string;
}

export interface RelatedModuleItem {
  icon: string;
  title: string;
  desc: string;
}

export interface GraphMetadata {
  title?: string;
  description?: string;
  complexity?: number;
  category?: string;
  roadmap?: RoadmapItem[];
  relatedModules?: RelatedModuleItem[];
}

/** A knowledge map as used by the screens. */
export interface GraphData {
  id?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: GraphMetadata;
  filename: string;
  fallbackUsed?: boolean;
}

/** Shape returned by /api/upload and by each item of /api/graphs. */
export interface SavedGraph {
  _id?: string;
  id?: string;
  filename: string;
  createdAt?: string;
  metadata?: GraphMetadata;
  graph: { nodes: any[]; edges: any[] };
  fallbackUsed?: boolean;
}

// ─── Document intelligence ──────────────────────────────────────────
export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface ExtractedField {
  key: string;
  label: string;
  type: string;
  format?: string;
  required: boolean;
  extra?: boolean;
  value: string | null;
  normalizedValue: string | number | string[] | null;
  modelConfidence: number;
  confidence: number;
  confidenceBand?: ConfidenceBand;
  confidenceDetail?: {
    model: number;
    verification: number;
    validation: number;
    quoteFound?: boolean;
    source: 'text_layer' | 'ocr' | null;
    capped?: string[];
  };
  page: number | null;
  sourceQuote: string | null;
}

export interface ExtractedEntity {
  type: string;
  value: string;
  page: number | null;
  sourceQuote: string | null;
  confidence?: number;
  confidenceBand?: ConfidenceBand;
}

export interface ExtractedTable {
  title: string;
  page: number | null;
  columns: string[];
  rows: string[][];
}

export interface DocumentIssue {
  severity: 'error' | 'warning' | 'info';
  type: 'missing' | 'inconsistent' | 'format' | 'low_confidence';
  fieldKeys: string[];
  message: string;
}

export interface IssueCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

/** A document extraction as returned by /api/extract and /api/documents/:id. */
export interface DocumentResult {
  id: string;
  filename: string;
  mimeType?: string;
  createdAt?: string;
  fallbackUsed?: boolean;
  docType: string;
  docTypeLabel: string;
  docTypeConfidence: number;
  title: string;
  language?: string;
  summary: string;
  ocrUsed: boolean;
  textLayer?: string;
  pageCount: number;
  overallConfidence: number | null;
  fields: ExtractedField[];
  entities: ExtractedEntity[];
  tables: ExtractedTable[];
  issues: DocumentIssue[];
  issueCounts?: IssueCounts;
  hasGraph?: boolean;
  cached?: boolean;
  warning?: string;
}

/** Short form from GET /api/documents. */
export interface DocumentSummary {
  id: string;
  filename: string;
  mimeType?: string;
  createdAt?: string;
  fallbackUsed?: boolean;
  docType: string;
  docTypeLabel: string;
  docTypeConfidence: number;
  title: string;
  summary: string;
  ocrUsed: boolean;
  pageCount: number;
  overallConfidence: number | null;
  fieldCount: number;
  issueCounts: IssueCounts;
  hasGraph: boolean;
}

export interface SearchHit {
  documentId: string;
  filename: string;
  title: string;
  docType: string;
  docTypeLabel: string;
  overallConfidence: number | null;
  createdAt?: string;
  kind: 'field' | 'entity' | 'summary' | 'issue' | 'text' | 'title' | 'document';
  fieldKey?: string;
  label: string;
  value: string | null;
  snippet: string;
  highlights: [number, number][];
  page: number | null;
  confidence: number | null;
  sourceQuote?: string;
  score: number;
}

// ─── Ask the documents ──────────────────────────────────────────────
export interface AskCitation {
  n: number;
  documentId: string;
  title: string;
  filename: string;
  docTypeLabel: string;
  kind: 'profile' | 'field' | 'issue' | 'text';
  page: number | null;
  fieldKey?: string;
  quote: string;
  verified: boolean;
}

export interface AskTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: AskCitation[];
  followUps?: string[];
  mode?: 'ai' | 'extractive' | 'none';
  notice?: string;
  error?: boolean;
  scopeLabel?: string;
  pending?: boolean;
}
