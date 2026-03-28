<?php

class SimpleClass {}
class ClassWithArgs {
    public function __construct($a, $b) {}
}

$obj = new SimpleClass();
$obj2 = new ClassWithArgs(1, "test");
$obj3 = new \Namespace\QualifiedClass();
