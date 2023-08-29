import { ClientFunction, Dependency, ServerFunction } from "./utils";

export class InternalUseSSRComputationError extends Error {
  result: any;
  constructor(message: string, result) {
    super(message);
    this.name = 'InternalUseSSRComputationError';
    this.result = result;
  }
}

export class UseSSRComputationError extends Error {
  dependencies: Dependency[];
  error?: any;
  result?: any;
  ssrComputationFile: string;
  constructor(message: string, dependencies: Dependency[], ssrComputationFile: string, error?: any, partialResult?: any) {
    super(message);
    this.name = 'UseSSRComputationError';
    this.dependencies = dependencies;
    this.error = error;
    this.result = partialResult;
    this.ssrComputationFile = ssrComputationFile;
  }
}

type ErrorHandler = (error: UseSSRComputationError) => void;
let errorHandler: ErrorHandler = () => {};

export const setErrorHandler = (handler: ErrorHandler) => {
  errorHandler = handler;
}

export const handleError = (error: UseSSRComputationError) => {
  if (typeof errorHandler === 'function') {
    errorHandler(error);
  } else {
    console.error(error);
  }
}

export const wrapErrorHandler = <T extends ServerFunction | ClientFunction>(useSSRComputation: T): T => {
  return ((...args: any[]) => {
    try {
      return (useSSRComputation as (...args: any) => any)(...args);
    } catch (error) {
      let message = '';
      let result = null;

      if (error instanceof InternalUseSSRComputationError) {
        message = error.message;
        result = error.result;
      } else {
        message = String(error);
      }

      const [_, dependencies, __, relativePathToCwd] = args;
      const useSSRComputationError = new UseSSRComputationError(message, dependencies, relativePathToCwd, error, result);
      handleError(useSSRComputationError);
      return result;
    }
  }) as T;
}
