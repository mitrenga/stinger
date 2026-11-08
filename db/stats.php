<?php

class DataCommand {
   
   public function execute($postData) {
      $mysqli = new mysqli($GLOBALS['dbHostname'], $GLOBALS['dbUser'], $GLOBALS['dbPassword'], $GLOBALS['dbName']);
      $periods = ['day', 'week',  'month', 'year','total'];
      $values = ['players', 'games'];
      $data = [];
      foreach ($periods as $period) {
         $data[$period] = [];
         foreach ($values as $value) {
            $data[$period][$value] = $this->getData($mysqli, (($period == 'total') ? '1' : '`created` >= NOW()-INTERVAL 1 '.strtoupper($period)), (($value == 'games') ? '*' : 'DISTINCT `name`'));
         }
      }
      $mysqli->close();
      return $data;
   } // execute

   public function getData($mysqli, $where, $calcKey) {
      return $mysqli->query('SELECT COUNT('.$calcKey.') as `count` FROM `rg_st_hallOfFame` WHERE ('.$where.')')->fetch_assoc()['count'];
   } // getData

} // class DataCommand

