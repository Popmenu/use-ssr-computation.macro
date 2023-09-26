import { renderHook } from '@testing-library/react-hooks';
import useSSRComputation_Client from './useSSRComputation_Client';
import {
  calculateCacheKey,
  ClientComputationFunction,
  Dependency,
  SSRComputationModule,
} from "./utils";
import { getSSRCache, setSSRCache } from "./ssrCache";
import { fetchSubscriptions, stopFetchingSubscriptionsForTesting } from "./subscriptions";

type MemoryLeakGuardedComputationFunction<TResult> = {
  called: { current: boolean },
  ssrComputationModule: SSRComputationModule<TResult>,
  emitNewValue: (value: TResult) => void,
  checkUnmounted: () => void,
  isSubscribed: { current: boolean },
}

type TestUtils<TResult> = Omit<MemoryLeakGuardedComputationFunction<TResult>, 'ssrComputationModule'> &
  ReturnType<typeof renderHook<unknown, TResult | null>> & {
    expectNoRerender: () => Promise<void>,
    computationLoaded: { current: boolean },
  }

const getMemoryLeakGuardedComputationFunction = <TResult>(defaultValue: TResult): MemoryLeakGuardedComputationFunction<TResult> => {
  let called = { current: false };
  let currentParam1: number;
  let isSubscribed = { current: false };
  let currentValue = defaultValue;
  let nextFn: ((value: TResult) => void) | undefined;

  const emitNewValue = (newValue: TResult) => {
    currentValue = newValue;
    if (nextFn) {
      setTimeout(() => {
        if (nextFn) {
          nextFn(newValue);
        }
      }, 0);
    }
  }

  const checkUnmounted = () => {
    if (isSubscribed.current) {
      throw new Error('Observable is still subscribed');
    }
    called.current = false;
    currentValue = defaultValue;
  }

  const ssrComputationModule: SSRComputationModule<TResult> = {
    compute: (param1: number) => {
      if (called.current && currentParam1 === param1) {
        throw new Error('Redundant call to the computation function with the same parameters');
      }
      if (isSubscribed.current) {
        throw new Error('The subscription is not unsubscribed before the new call');
      }
      called.current = true;
      currentParam1 = param1;

      return currentValue;
    },
    subscribe: (next: (result: TResult) => void, param1: number) => {
      if (!called.current || currentParam1 !== param1) {
        throw new Error('The computation function is not called before subscribing');
      }
      if (isSubscribed.current && currentParam1 === param1) {
        throw new Error('Redundant call to the subscription function with the same parameters');
      }
      if (isSubscribed.current) {
        throw new Error('Observable is not unsubscribed before the new call');
      }
      isSubscribed.current = true;
      nextFn = next;

      setTimeout(() => {
        next(currentValue);
      }, 0);

      return {
        unsubscribe: () => {
          isSubscribed.current = false;
          nextFn = undefined;
        }
      }
    },
  } as SSRComputationModule<TResult>;

  return {
    called,
    ssrComputationModule: ssrComputationModule as SSRComputationModule<TResult>,
    emitNewValue,
    checkUnmounted,
    isSubscribed,
  }
}

const createImportFn = <TResult>(ssrComputationModule: SSRComputationModule<TResult>): {
  importFn: ClientComputationFunction<TResult>,
  computationLoaded: { current: boolean },
} => {
  const computationLoaded = { current: false };
  const importFn = () => {
    computationLoaded.current = true;
    return new Promise<SSRComputationModule<TResult>>(resolve => resolve(ssrComputationModule));
  };

  return { computationLoaded, importFn };
};

beforeEach(() => {
  setSSRCache({});
  stopFetchingSubscriptionsForTesting();
});

const relativePathToCwd = 'example/example.js';
const dependencies: Dependency[] = [1];

const runBaseMemoryLeakTest = async <TResult>(
  defaultValue: TResult | null,
  { alreadyCached, cachedValue }: { alreadyCached?: boolean, cachedValue?: TResult },
  test: ((testUtils: TestUtils<TResult>) => Promise<void>) | null = null,
) => {
  const { ssrComputationModule, ...ssrComputationFunctionUtils } = getMemoryLeakGuardedComputationFunction(defaultValue);
  const { checkUnmounted } = ssrComputationFunctionUtils;
  const { importFn, computationLoaded } = createImportFn(ssrComputationModule);

  const hookUtils = renderHook(() => useSSRComputation_Client(importFn, dependencies, {}, relativePathToCwd));
  const {
    result,
    unmount,
    waitForNextUpdate
  } = hookUtils;
  const expectNoRerender = () => expect(waitForNextUpdate({ timeout: 250 })).rejects.toThrowError('Timed out');
  // if the value is already cached, it should returned in the first call and not wait for the next update
  expect(result.current).toBe(alreadyCached ? cachedValue : null);

  if (defaultValue != null && !alreadyCached) {
    await waitForNextUpdate();
    expect(result.current).toBe(defaultValue);
  }

  if (test) {
    await test({
      expectNoRerender,
      computationLoaded,
      ...ssrComputationFunctionUtils,
      ...hookUtils,
    });
  }

  // expect the hook not to make any redundant renders
  await expectNoRerender();

  unmount();
  checkUnmounted();
}

const cacheValue = <TResult>(value: TResult, isSubscription: boolean) => {
  const cacheKey = calculateCacheKey(relativePathToCwd, dependencies);
  getSSRCache()[cacheKey] = {
    result: value,
    isSubscription,
  };
}

test('useSSRComputation_Client should load the subscription function and return the next result in one render cycle', async () => {
  await runBaseMemoryLeakTest(0, {});
});

test("useSSRComputation_Client doesn't rerender if the subscription didn't emit any values", async () => {
  await runBaseMemoryLeakTest(null, {});
});

test('useSSRComputation_Client updates the subscription result in one render cycle', async () => {
  await runBaseMemoryLeakTest(0, {}, async (testUtils) => {
    const { waitForNextUpdate, emitNewValue, result } = testUtils;
    emitNewValue(4);
    await waitForNextUpdate();
    expect(result.current).toBe(4);
  });
});

test("useSSRComputation_Client returns the cached value at the first call", async () => {
  await runBaseMemoryLeakTest(5, {});
  await runBaseMemoryLeakTest(5, { alreadyCached: true, cachedValue: 5 });
});

test("useSSRComputation_Client only subscribe to subscriptions after calling 'fetchSubscriptions'", async () => {
  await runBaseMemoryLeakTest(5, {});

  await runBaseMemoryLeakTest(20, { alreadyCached: true, cachedValue: 5 }, async (testUtils) => {
    const { emitNewValue, expectNoRerender, waitForNextUpdate, result, isSubscribed } = testUtils;

    // Observables will not be subscribed until calling fetchSubscriptions()
    await expectNoRerender();
    expect(isSubscribed.current).toBe(false);

    fetchSubscriptions();
    await waitForNextUpdate();
    expect(result.current).toBe(20);

    emitNewValue(25);
    await waitForNextUpdate();
    expect(result.current).toBe(25);
  });
});

[false, true].forEach((isSubscription) => {
  test(`useSSRComputation_Client should not load the computation if the ${isSubscription ? 'subscription' : 'result'} is cached`, async () => {
    cacheValue(5, isSubscription);
    await runBaseMemoryLeakTest(5, { alreadyCached: true, cachedValue: 5 }, async (testUtils) => {
      const { rerender, expectNoRerender, computationLoaded, called } = testUtils;
      expect(computationLoaded.current).toBe(false);
      expect(called.current).toBe(false);
      await expectNoRerender();

      rerender();
      expect(computationLoaded.current).toBe(false);
      expect(called.current).toBe(false);
    });
  });
});

test('useSSRComputation_Client should fetch subscriptions after calling "fetchSubscriptions" even if it is cached', async () => {
  cacheValue(5, true);
  await runBaseMemoryLeakTest(5, { alreadyCached: true, cachedValue: 5 }, async (testUtils) => {
    const { rerender, waitForNextUpdate, result, emitNewValue, expectNoRerender } = testUtils;
    fetchSubscriptions();
    await expectNoRerender();
    expect(result.current).toBe(5);

    emitNewValue(10);
    await waitForNextUpdate();
    expect(result.current).toBe(10);

    rerender();
    expect(result.current).toBe(10);
  });
});

[false, true].forEach((isSSRCached) => {
  test('useSSRComputation_Client should resubscribe if it is unmounted and mounted again', async () => {
    if (isSSRCached) {
      cacheValue(10, true);
      await runBaseMemoryLeakTest(/*currentValue:*/15, { alreadyCached: true, cachedValue: 10 }, async (testUtils) => {
        const { emitNewValue, expectNoRerender } = testUtils;
        emitNewValue(20);
        await expectNoRerender();
      });
    } else {
      await runBaseMemoryLeakTest(/*currentValue:*/5, {}, async (testUtils) => {
        const { waitForNextUpdate, emitNewValue, result } = testUtils;
        emitNewValue(10);
        await waitForNextUpdate();
        expect(result.current).toBe(10);
      });
    }

    // if the component is completely unmounted, the computation function is lost and need to be loaded again
    // it will return the latest cached value "10" instead of the current value "15".
    // The function will be loaded and run again after calling "fetchSubscriptions"
    // TODO: the functions loaded can be cached as well to avoid loading them again
    await runBaseMemoryLeakTest(15, { alreadyCached: true, cachedValue: 10 }, async (testUtils) => {
      const { waitForNextUpdate, emitNewValue, result, expectNoRerender } = testUtils;
      await expectNoRerender();

      emitNewValue(20);
      await expectNoRerender();

      fetchSubscriptions();
      await waitForNextUpdate();
      expect(result.current).toBe(20);
    });
  });
});
