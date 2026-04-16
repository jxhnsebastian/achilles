import mongoose, { Document, Schema } from "mongoose";

export interface IMarket extends Document {
  platform: string;
  id: string;
  title: string;
  description?: string;
  category?: string;
  status: string;
  resolutionTime?: Date;
  createdAt: Date;
  updatedAt: Date;
  dbCreatedAt: Date;      // set once on first insert
  dbUpdatedAt: Date;      // refreshed on every upsert
  volume?: number;
  liquidity?: number;
  tags?: string[];
  outcomes?: Record<string, unknown>;
  raw: Record<string, unknown>;
  embeddingId?: string;
  embeddingHash?: string;
  isMve: boolean;
}

const MarketSchema = new Schema<IMarket>(
  {
    platform: { type: String, required: true },
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: { type: String },
    category: { type: String },
    status: { type: String, required: true },
    resolutionTime: { type: Date },
    volume: { type: Number },
    liquidity: { type: Number },
    tags: { type: [String] },
    outcomes: { type: Schema.Types.Mixed },
    raw: { type: Schema.Types.Mixed, required: true },
    embeddingId: { type: String },
    embeddingHash: { type: String },
    isMve: { type: Boolean, required: true, default: false },
    createdAt: { type: Date, default: null },    // from API
    updatedAt: { type: Date, default: null },    // from API
    dbCreatedAt: { type: Date, required: true },
    dbUpdatedAt: { type: Date, required: true },
  },
  {
    timestamps: false,
  }
);

// Compound unique index matching the Postgres PRIMARY KEY (platform, id)
MarketSchema.index({ platform: 1, id: 1 }, { unique: true });
MarketSchema.index({ status: 1 });
MarketSchema.index({ resolutionTime: 1 });
MarketSchema.index({ category: 1 });
MarketSchema.index({ isMve: 1 });

export const Market = mongoose.model<IMarket>("Market", MarketSchema);
