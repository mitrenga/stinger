<?php

class DataCommand {

   public function execute($postData) {
      $version = 'unknown';
      $source = file_get_contents('app/version.js');
      if (preg_match("/Version\s*=\s*'([^']+)'/", $source, $m)) {
         $version = $m[1];
      }
      return ['version' => $version];
   } // execute

} // class DataCommand
