import mongoose, { Document, Schema } from "mongoose";

export type RequestStatus = "pending" | "completed" | "failed";

export interface IRequest extends Document {
  requestId: string;
  markets: string[];
  result?: Record<string, unknown>;
  status: RequestStatus;
  createdAt: Date;
  updatedAt: Date;
}

const RequestSchema = new Schema<IRequest>(
  {
    requestId: { type: String, required: true, unique: true },
    markets: { type: [String], required: true },
    result: { type: Schema.Types.Mixed, default: null },
    status: {
      type: String,
      required: true,
      enum: ["pending", "completed", "failed"] satisfies RequestStatus[],
    },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  }
);

export const Request = mongoose.model<IRequest>("Request", RequestSchema);
