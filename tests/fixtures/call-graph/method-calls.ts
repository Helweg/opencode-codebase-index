// Method calls test fixture
// Tests object.method() and this.method() patterns

class Calculator {
  value: number = 0;

  add(n: number) {
    this.value += n;
    this.validate();           // this.method() call
    return this;
  }

  subtract(n: number) {
    this.value -= n;
    return this;
  }

  validate() {
    if (this.value < 0) {
      this.reset();            // Another this.method() call
    }
  }

  reset() {
    this.value = 0;
  }
}

// Object method calls
const calc = new Calculator();
calc.add(5);                   // obj.method() call
calc.subtract(2);              // Chained method call
calc.add(3).subtract(1);       // Method chaining

// Static method calls
class MathUtils {
  static square(n: number) {
    return n * n;
  }

  static cube(n: number) {
    return MathUtils.square(n) * n;  // Static method calling static method
  }
}

MathUtils.square(5);           // Static method call
MathUtils.cube(3);
