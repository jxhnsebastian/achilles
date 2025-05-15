import { fetchWithRetry } from "./helpers";
import { FordefiWallets } from "./types";

interface Vault {
  id: string;
  address: string;
  name: string;
}

interface FordefiVaultsResponse {
  total: number;
  page: number;
  size: number;
  vaults: Vault[];
}

async function fetchAllVaults(): Promise<Vault[]> {
  let allVaults: Vault[] = [];
  let currentPage = 1;
  let hasMorePages = true;

  const myHeaders = new Headers();
  myHeaders.append(
    "Authorization",
    `Bearer ${process.env.FORDEFI_ACCESS_TOKEN!}`
  );
  const requestOptions = {
    method: "GET",
    headers: myHeaders,
  };

  while (hasMorePages) {
    const response = await fetchWithRetry<FordefiVaultsResponse>(
      `https://api.fordefi.com/api/v1/vaults?page=${currentPage}&size=100`,
      requestOptions
    );

    allVaults = [...allVaults, ...response.vaults];

    const totalPages = Math.ceil(response.total / response.size);
    if (currentPage >= totalPages) {
      hasMorePages = false;
    } else {
      currentPage++;
    }
  }

  return allVaults;
}

function formatWallets(vaults: Vault[]): FordefiWallets {
  const formattedWallets: FordefiWallets = {};

  vaults.forEach((vault) => {
    formattedWallets[vault.address] = {
      vaultId: vault.id,
      privateKey: "",
      id: vault.name,
    };
  });

  return formattedWallets;
}

export async function getFordefiWallets(): Promise<FordefiWallets> {
  try {
    const vaults = await fetchAllVaults();
    const formattedWallets = formatWallets(vaults);
    return formattedWallets;
  } catch (e: any) {
    console.error("Error fetching Fordefi wallets:", e);
    throw new Error(
      `Failed to fetch fordefi wallets. ${e?.message ?? "Unknown Error!"}`
    );
  }
}
