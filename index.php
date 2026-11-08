<?php
  $appName = 'STINGER';
  $appDescription = 'Play STINGER online for free in your browser. Faithful remake of the 1983 Seibu Denshi arcade shooter Stinger with no download required.';
  $appPrefix = 'st';
  $appNoscript =
    '<h1>STINGER</h1>'.
    '<p>Stinger is the 1983 arcade shooter by Seibu Denshi — their very first game. '.
    'You fly along a huge space fortress on a vertically oriented screen, shooting swarms of aliens, '.
    'saucers and rockets, and you can call the Bongo, a helper that hunts the enemies for you.</p>'.
    '<p>This is a faithful remake of the arcade version that runs directly in your web browser. '.
    'There is nothing to install and nothing to download — just open the page and play. '.
    'Please enable JavaScript to start the game.</p>'.
    '<p><a href="about">More about Stinger and this remake</a></p>';
  $appOpenGraph = [
    'image' => 'images/poster.png',
  ];
  $appJsonLd = [
    'genre' => 'Shoot \'em up',
    'isBasedOn' => [
      '@type' => 'VideoGame',
      'name' => 'Stinger',
      'publisher' => [
        ['@type' => 'Organization', 'name' => 'Seibu Denshi'],
      ],
      'datePublished' => '1983',
      'gamePlatform' => 'Arcade',
    ],
  ];
  require_once 'config/config.php';
  require_once 'app/svision/php/main.php';
