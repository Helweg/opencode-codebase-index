public class MethodCalls {
    public void runner(Validator obj, Calculator calc) {
        // Instance method calls
        obj.validate('payload');
        calc.add(1, 2);
        calc.subtract(5, 3);

        // this-call
        this.cleanup();

        // Static method call
        MyService.staticDo();

        // Chained method call (case-mixed for normalization test)
        Foo.Bar.DeepCall();

        // Method call with same name in different cases
        obj.Method();
    }

    public void cleanup() {}
}
