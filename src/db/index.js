/**
 * DB routing barrel.
 *
 * STORAGE=sqlite  → forensic-sqlite.js (Node 24 built-in sqlite, no server, recommended)
 * STORAGE=postgres → forensic.js (Postgres + pgvector)
 *
 * All pipeline files import from here so they never need to know which backend
 * is active.  dotenv is loaded here for cases where this module is imported
 * before the entry-point has loaded it.
 */
import 'dotenv/config';

const storage = process.env.STORAGE || 'sqlite';
const mod = await import(storage === 'sqlite' ? './forensic-sqlite.js' : './forensic.js');

export const connect                  = mod.connect;
export const isIngested               = mod.isIngested;
export const registerSource           = mod.registerSource;
export const logCustody               = mod.logCustody;
export const logStage                 = mod.logStage;
export const insertWords              = mod.insertWords;
export const upsertSpeaker            = mod.upsertSpeaker;
export const insertUtterance          = mod.insertUtterance;
export const insertEmbedding          = mod.insertEmbedding;
export const insertEvent              = mod.insertEvent;
export const insertFrameSignature     = mod.insertFrameSignature;
export const insertLocationOfInterest = mod.insertLocationOfInterest;
export const sourcesNeedingReview     = mod.sourcesNeedingReview;
export const gatherForReview          = mod.gatherForReview;
export const insertContextAnnotation  = mod.insertContextAnnotation;
export const getPool                  = mod.getPool;
export const loadEnrollments          = mod.loadEnrollments;
