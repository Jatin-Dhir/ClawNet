import React from 'react';
import { useOutletContext } from 'react-router-dom';
import Hero from '../components/Hero';
import About from '../components/About';
import TeamPreview from '../components/TeamPreview';
import Products from '../components/Products';
import Blog from '../components/Blog';
import Stats from '../components/Stats';
import CommunityIntro from '../components/community/CommunityIntro';

const LandingPage = () => {
  const { onSignInClick, triggerTransition } = useOutletContext();

  return (
    <div className="space-y-20 sm:space-y-24">
      <Hero onJoinClick={() => triggerTransition(onSignInClick)} />
      <About />
      <TeamPreview />
      <Products />
      <Blog />
      <CommunityIntro onSignInClick={onSignInClick} triggerTransition={triggerTransition} />
      <Stats />
    </div>
  );
};

export default LandingPage;
