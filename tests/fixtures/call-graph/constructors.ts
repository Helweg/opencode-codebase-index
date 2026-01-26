// Constructor calls test fixture
// Tests new Constructor() patterns

class SimpleClass {
  constructor() {}
}

class ClassWithArgs {
  name: string;
  value: number;

  constructor(name: string, value: number) {
    this.name = name;
    this.value = value;
  }
}

class NestedConstruction {
  inner: SimpleClass;

  constructor() {
    this.inner = new SimpleClass();    // Constructor call in constructor
  }
}

// Direct constructor calls
const obj1 = new SimpleClass();
const obj2 = new ClassWithArgs("test", 42);
const obj3 = new NestedConstruction();

// Constructor with complex args
const obj4 = new ClassWithArgs(
  getName(),
  getValue()
);

function getName() {
  return "dynamic";
}

function getValue() {
  return 100;
}

// Generic constructor
class GenericBox<T> {
  value: T;
  constructor(val: T) {
    this.value = val;
  }
}

const box = new GenericBox<number>(42);
