// Edge cases test fixture
// Tests optional chaining, dynamic imports, and other tricky patterns

// Optional chaining
function optionalCalls(obj?: any) {
  obj?.method();                   // Optional method call
  obj?.nested?.deep?.call();       // Multiple optional chains
  const result = obj?.compute?.(5); // Optional call with args
  return result;
}

// Dynamic property access
function dynamicCalls(obj: any, methodName: string) {
  obj[methodName]();               // Dynamic method call
  obj["staticName"]();             // Bracket notation
}

// IIFE (Immediately Invoked Function Expression)
(function immediate() {
  console.log("IIFE");
})();

// Arrow function immediate call
(() => {
  setup();
})();

function setup() {}

// Conditional calls
function conditionalExecution(flag: boolean) {
  if (flag) {
    trueCase();
  } else {
    falseCase();
  }
  
  flag ? whenTrue() : whenFalse();  // Ternary
}

function trueCase() {}
function falseCase() {}
function whenTrue() {}
function whenFalse() {}

// Try-catch with calls
function errorHandling() {
  try {
    riskyOperation();
  } catch (error) {
    handleError(error);
  } finally {
    cleanup();
  }
}

function riskyOperation() {
  throw new Error("test");
}

function handleError(e: any) {}
function cleanup() {}

// Async/await patterns
async function asyncCalls() {
  await fetchData();               // Await call
  
  const result = await Promise.all([
    asyncOp1(),                    // Call in array
    asyncOp2(),
  ]);
  
  return result;
}

async function fetchData() {
  return {};
}

async function asyncOp1() {
  return 1;
}

async function asyncOp2() {
  return 2;
}

// Generator functions
function* generatorCalls() {
  yield getValue();                // Call in yield
  yield* otherGenerator();         // Delegated generator
}

function getValue() {
  return 42;
}

function* otherGenerator() {
  yield 1;
  yield 2;
}

// Destructuring with calls
function destructuringCalls() {
  const { a, b } = getObject();
  const [x, y] = getArray();
}

function getObject() {
  return { a: 1, b: 2 };
}

function getArray() {
  return [1, 2];
}

// Spread operator with calls
function spreadCalls() {
  const arr = [...getArray()];
  const obj = { ...getObject() };
  
  combine(...getArgs());           // Spread in call args
}

function combine(...args: any[]) {
  return args;
}

function getArgs() {
  return [1, 2, 3];
}

// Tagged template literals
function taggedTemplate() {
  const result = myTag`template ${getValue()} string`;
}

function myTag(strings: TemplateStringsArray, ...values: any[]) {
  return strings[0] + values[0];
}
