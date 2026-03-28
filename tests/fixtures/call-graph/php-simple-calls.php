<?php

function caller() {
    directCall();
    helper(1, 2);
    $result = compute($data);
    HELPER(3, 4);
}

function directCall() {
    echo "called";
}

function helper($a, $b) {
    return $a + $b;
}

function compute($d) {
    return $d;
}
