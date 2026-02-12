export interface TwitterAPITweet {
  type: string;
  id: string;
  url: string;
  text: string;
  source: string;
  retweetCount: number;
  replyCount: number;
  likeCount: number;
  quoteCount: number;
  viewCount: number;
  createdAt: string;
  lang: string;
  bookmarkCount: number;
  isReply: boolean;
  inReplyToId?: string;
  conversationId?: string;
  author: {
    userName: string;
    name: string;
    id: string;
    followers: number;
    isBlueVerified: boolean;
    description: string;
  };
  entities?: {
    hashtags?: Array<{ text: string; indices: number[] }>;
    urls?: Array<{ display_url: string; expanded_url: string; url: string }>;
    user_mentions?: Array<{
      id_str: string;
      name: string;
      screen_name: string;
    }>;
  };
}

export interface TwitterThreadResponse {
  tweets: TwitterAPITweet[];
  has_next_page: boolean;
  next_cursor: string;
  status: string;
  message?: string;
}

export interface AnalysisResult {
  summary: string[];
  topic: string;
}

export interface PineconeMarketHit {
  market_id: string;
  platform: "polymarket" | "kalshi";
  score: number;
  metadata: {
    market_id: string;
    platform: string;
    title: string;
    resolution_time: number | null;
    status: string;
    liquidity: number | null;
    volume: number | null;
    tags: string | null;
  };
}

export interface CandidateMarket {
  market_id: string;
  platform: "polymarket" | string;
  fullMarketData: NormalizedMarket;
}

export interface AnalyzeThreadConfig {
  requestId: string;
  tweetId: string;
  topK?: number;
}

export interface TweetThread {
  author: string;
  authorHandle: string;
  tweetCount: number;
  text: string;
}

export interface AnalyzeThreadResult {
  threadContext: TweetThread;
  markets: EnrichedPineconeMarketHit[];
  error?: string;
  message?: string;
}

export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  resolutionSource: string;
  endDate: string;
  liquidity: string;
  startDate: string;
  image: string;
  icon: string;
  description: string;
  volume: string;
  active: boolean;
  closed: boolean;
  createdAt: string;
  updatedAt: string;
  new: boolean;
  questionID: string;
  volumeNum: number;
  liquidityNum: number;
  endDateIso: string;
  startDateIso: string;
  events?: any[];
  tags?: any[];
  [key: string]: any; // For any additional fields
}

export interface NormalizedMarket {
  id: string;
  question: string;
  endDate: string;
  startDate: string;
  description: string;
  tags: string[];
  events: Array<{
    title: string;
    series: string[];
    description: string;
  }>;
  marketType?: string;
}

export interface EnrichedPineconeMarketHit extends PineconeMarketHit {
  fullMarketData?: PolymarketMarket | null;
}

export interface GenerateParlaysConfig {
  requestId: string;
  tweetId: string;
}

export interface ApprovedParlay {
  marketIds: string[];
  verdict: "approved";
  reason: string;
}

export interface RejectedParlay {
  marketIds: string[];
  verdict: "rejected";
  reason: string;
}

export interface GenerateParlaysResult {
  requestId: string;
  threadContext: {
    author: string;
    authorHandle: string;
    tweetCount: number;
  };
  approvedParlays: ApprovedParlay[];
  rejectedParlays: RejectedParlay[];
  error?: string;
  message?: string;
}

export interface Stage1Output {
  selectedMarketIds: string[];
}

export interface ParlayCandidate {
  marketIds: string[];
  reason: string;
}

export interface Stage2Output {
  parlays: ParlayCandidate[];
}

export interface Stage3Output {
  approvedParlays: ApprovedParlay[];
  rejectedParlays: RejectedParlay[];
}

export interface RequestStatusResponse {
  requestId: string;
  markets?: string[];
  approvedParlays?: ApprovedParlay[];
  rejectedParlays?: RejectedParlay[];
}
