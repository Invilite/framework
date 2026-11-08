/**
 * Vocabulary of Ollama's decision API (POST /v1/systemone, "System One"). Decision
 * models (e.g. Cloudflare's clef) do not chat: they score every option of every
 * question in one pass and return probabilities. Wire names (`noul`, `choice`,
 * `score`) are kept as-is so payloads match the Ollama docs one-to-one.
 */

import {OpenAiImage} from "../OpenAi/OpenAiTypes";

/** Pick one option; `null` lets the option name describe itself. */
export interface OllamaChoiceQuestion {
    type: 'choice';
    instructions: string;
    criteria: Record<string, string | null>;
}

/** Yes/no question; answered with the probability that it is true. */
export interface OllamaNoulQuestion {
    type: 'noul';
    instructions: string;
    criteria?: { true: string; false: string };
}

/** Ordered scale, lowest level first; levels are numbered from 0. */
export interface OllamaScoreQuestion {
    type: 'score';
    instructions: string;
    criteria: string[];
}

export type OllamaDecisionQuestion = OllamaChoiceQuestion | OllamaNoulQuestion | OllamaScoreQuestion;

/** Questions keyed by name; answers come back under the same names. */
export type OllamaDecisionQuestions = Record<string, OllamaDecisionQuestion>;

export interface OllamaChoiceAnswer {
    type: 'choice';
    choice: string;
    probabilities: Record<string, number>;
    /** How concentrated the probabilities are - NOT the chance the answer is right. */
    confidence: number;
}

export interface OllamaNoulAnswer {
    type: 'noul';
    /** Probability that the answer is true. */
    noul: number;
}

export interface OllamaScoreAnswer {
    type: 'score';
    /** Probability-weighted level (e.g. 1.55 between levels 1 and 2). */
    score: number;
    legend: Record<string, string>;
    probabilities: Record<string, number>;
    confidence: number;
}

export type OllamaDecisionAnswer = OllamaChoiceAnswer | OllamaNoulAnswer | OllamaScoreAnswer;

type AnswerFor<Q extends OllamaDecisionQuestion> =
    Q extends OllamaChoiceQuestion ? OllamaChoiceAnswer
        : Q extends OllamaNoulQuestion ? OllamaNoulAnswer
            : OllamaScoreAnswer;

/** Answer type follows each question's type, so `answers.harm.noul` needs no narrowing. */
export type OllamaDecisionAnswers<Q extends OllamaDecisionQuestions> = { [K in keyof Q]: AnswerFor<Q[K]> };

/** Text, or a JSON object/array for structured input. Required even when judging images. */
export type OllamaDecisionState = string | Record<string, unknown> | unknown[];

export interface OllamaDecision<Q extends OllamaDecisionQuestions> {
    answers: OllamaDecisionAnswers<Q>;
    usage: { inputTokens?: number };
    model: string;
}

export interface OllamaDecideOptions {
    model?: string;
    timeout?: number;
    /** Shared by all questions, in request order. PNG, JPEG or WebP only. */
    images?: OpenAiImage[];
    /** Per-image limit; defaults to the cloud limit (4 MiB). */
    maxImageBytes?: number;
}

/** Minimal surface consumers depend on (also the test seam for services). */
export interface OllamaDecisionClient {
    readonly name: string;

    decide<Q extends OllamaDecisionQuestions>(
        state: OllamaDecisionState,
        questions: Q,
        options?: OllamaDecideOptions,
    ): Promise<OllamaDecision<Q>>;
}
