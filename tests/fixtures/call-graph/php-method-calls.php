<?php

class Calculator {
    public function add($n) {
        $this->validate();
        return $this;
    }

    public function subtract($n) {
        return $this;
    }

    public function validate() {
        return true;
    }

    public function reset() {
        return $this;
    }

    public static function create() {
        return new self();
    }
}

$calc = new Calculator();
$calc->add(5);
$calc->subtract(2);
$calc?->reset();
Calculator::create();
