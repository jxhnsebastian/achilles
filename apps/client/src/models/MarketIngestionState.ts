import mongoose, { Document, Schema } from "mongoose";

export interface IMarketIngestionState extends Document {
  platform: string;
  lastCreatedAt?: Date;
  lastUpdatedAt?: Date;
  updatedAt: Date;
}

const MarketIngestionStateSchema = new Schema<IMarketIngestionState>(
  {
    platform: { type: String, required: true, unique: true },
    lastCreatedAt: { type: Date, default: null },
    lastUpdatedAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: false, updatedAt: "updatedAt" },
  }
);

export const MarketIngestionState = mongoose.model<IMarketIngestionState>(
  "MarketIngestionState",
  MarketIngestionStateSchema
);
