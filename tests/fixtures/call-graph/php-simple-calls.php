<?php

function caller() {
    directCall();
    helper(1, 2);
    $result = compute($data);
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
