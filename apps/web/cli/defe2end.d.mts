import type { PrismaClient } from "@defe2end/db";

export declare class CliError extends Error {}
export declare const ADMIN_MEMBERSHIP_LOCK: number;
export declare function resetLinkCommand(db: PrismaClient, email: string): Promise<string>;
export declare function createAdminCommand(db: PrismaClient, email: string): Promise<string>;
export declare function main(argv?: string[], db?: PrismaClient): Promise<number>;
