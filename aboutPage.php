<?php

require_once 'app/svision/php/abstractAboutPage.php';

/**
 * The /about page: the story of the original Stinger and this remake.
 * ST-M2 placeholder text; the final content comes with ST-M7/ST-M8.
 */
class AboutPage extends AbstractAboutPage {

  protected function aboutData() {
    return [
      'image' => 'images/cover.png',
      'sections' => [
        [
          'heading' => 'The original game (1983)',
          'html' =>
            '<p>Stinger was released by Seibu Denshi in September 1983 as the company\'s first game '.
            '(distributed by Sigma in Japan and Venture Line in the USA). It is a horizontally scrolling '.
            'shooter on a vertically oriented monitor: you fly along a huge space fortress through 31 rounds, '.
            'shooting swarms of aliens, saucers and rockets, and you can call the Bongo — a helper that '.
            'hunts the enemies for a while.</p>',
        ],
        [
          'heading' => 'This remake',
          'html' =>
            '<p>This is a faithful remake of the Seibu Denshi arcade version: the original game logic is being '.
            'rewritten for the web browser from the program ROM, not emulated. It runs directly in your '.
            'browser — nothing to install, nothing to download. Keyboard, touch controls and gamepads '.
            'are supported.</p>'.$this->installNote(),
        ],
        [
          'heading' => 'Other games',
          'html' =>
            '<p>This remake is one of a growing collection of classic games from the 8-bit and 16-bit era '.
            '— ZX Spectrum, Commodore 64, arcade and more — rebuilt faithfully on the same library and '.
            'playable in your browser, free of charge. Browse the whole collection at '.
            '<a href="https://retrogames.free/" target="_blank" rel="noopener">retrogames.free</a>.</p>',
        ],
      ],
      'links' => [
        ['label' => 'Stinger on Wikipedia', 'url' => 'https://en.wikipedia.org/wiki/Stinger_(1983_video_game)'],
      ],
      'footer' =>
        '<p>An unofficial fan remake. The original game and its artwork belong to their authors (Tehkan). '.
        'The remake\'s source code is licensed under <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>.</p>',
    ];
  } // aboutData

} // AboutPage
