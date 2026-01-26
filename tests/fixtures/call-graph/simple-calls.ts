// Direct function calls test fixture
// Tests basic function-to-function call patterns

function caller() {
  directCall();                    // Direct function call - no args
  helper(1, 2);                    // Call with arguments
  const result = compute(data);    // Call with assignment
  nested.deep.call();              // Nested member access call
}

function directCall() {
  console.log("called");
}

function helper(a: number, b: number) {
  return a + b;
}

function compute(d: any) {
  return d;
}

const data = { value: 42 };
const nested = { deep: { call: () => {} } };
