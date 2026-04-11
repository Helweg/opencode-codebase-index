<?php

// Test zero-allocation method call detection
// Uses method_call_expression patterns

class Service {
    public function process($data) {
        return $this->validate($data);
    }

    public function validate($data) {
        return $data !== null;
    }

    public static function create() {
        return new self();
    }
}

// Direct method calls
$service = new Service();
$service->process("data");
$service->validate("data");

// Static method calls
Service::create();

// Chain calls
$service->process("data")->validate("data");
