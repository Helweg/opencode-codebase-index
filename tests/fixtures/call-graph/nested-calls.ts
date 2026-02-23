// Nested calls test fixture
// Tests deeply nested and complex call patterns

function outer() {
  inner(middle(deep()));           // Triple-nested call
  
  const result = compute(
    transform(
      getData()                    // Nested in function args
    )
  );
  
  return result;
}

function inner(value: any) {
  return process(value);           // Call in return
}

function middle(value: any) {
  return normalize(value);
}

function deep() {
  return fetch();
}

function compute(data: any) {
  return data;
}

function transform(data: any) {
  return validate(sanitize(data)); // Nested in return
}

function getData() {
  return { value: 42 };
}

function process(v: any) {
  return v;
}

function normalize(v: any) {
  return v;
}

function fetch() {
  return {};
}

function validate(v: any) {
  return v;
}

function sanitize(v: any) {
  return v;
}

// Callback nesting
function withCallback() {
  doAsync((result) => {
    process(result);               // Call in callback
    
    doAsync((nested) => {
      finalize(nested);            // Call in nested callback
    });
  });
}

function doAsync(cb: (result: any) => void) {
  cb({});
}

function finalize(v: any) {
  return v;
}

// Array method chaining with calls
function chainedCalls() {
  const data = [1, 2, 3];
  
  return data
    .map(x => square(x))           // Call in arrow function
    .filter(x => isValid(x))       // Call in another arrow
    .reduce((a, b) => sum(a, b));  // Call in reducer
}

function square(n: number) {
  return n * n;
}

function isValid(n: number) {
  return n > 0;
}

function sum(a: number, b: number) {
  return a + b;
}
