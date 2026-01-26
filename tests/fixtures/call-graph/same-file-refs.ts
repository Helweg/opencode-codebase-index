// Same-file references test fixture
// Tests resolution of calls within the same file
// All calls here should be resolvable (is_resolved=true)

function entryPoint() {
  helperA();                       // Should resolve to helperA below
  helperB(42);                     // Should resolve to helperB below
  
  const obj = new MyClass();       // Should resolve to MyClass constructor
  obj.doWork();                    // Should resolve to MyClass.doWork
  
  MyClass.staticMethod();          // Should resolve to static method
}

function helperA() {
  helperB(10);                     // Should resolve to helperB
  internalUtil();                  // Should resolve to internalUtil
}

function helperB(n: number) {
  return n * 2;
}

function internalUtil() {
  return "util";
}

class MyClass {
  static staticMethod() {
    return "static";
  }
  
  doWork() {
    this.privateMethod();          // Should resolve to privateMethod
    return "work";
  }
  
  privateMethod() {
    return "private";
  }
}

// Arrow functions
const arrowFunc = () => {
  helperA();                       // Should resolve to helperA
};

// Function expressions
const funcExpr = function() {
  helperB(5);                      // Should resolve to helperB
};

// Nested scopes
function outerScope() {
  function innerScope() {
    helperA();                     // Should resolve to top-level helperA
  }
  
  innerScope();                    // Should resolve to innerScope above
}

// Mutual recursion
function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);  // Self-call, should resolve to itself
}

function evenOdd(n: number): boolean {
  if (n === 0) return true;
  return isOdd(n - 1);             // Should resolve to isOdd below
}

function isOdd(n: number): boolean {
  if (n === 0) return false;
  return evenOdd(n - 1);           // Should resolve to evenOdd above
}

// Export doesn't change resolution
export function exported() {
  helperA();                       // Still resolves within same file
}
