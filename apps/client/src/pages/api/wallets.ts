import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "./auth/[...nextauth]";
import {
  getFordefiWallets,
} from "@achilles/utils";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Check authentication
  const session = await getServerSession(req, res, authOptions);

  if (!session) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const wallets = await getFordefiWallets();

    return res.status(200).json(wallets);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Failed to fetch wallets from Fordefi API",
    });
  }
}
